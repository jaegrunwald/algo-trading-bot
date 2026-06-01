#!/usr/bin/env python3
"""
Alpaca runner: Finviz watchlist → ML scores → optional long entries and protective exits;
appends rows to ``portfolio_stats.csv``. Flags and env are documented in ``.env.example``;
repo layout is in ``ARCHITECTURE.md`` (do not duplicate long behavior docs here).
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

_ENV_FILE = ROOT / ".env"
# override=True: values in .env replace any empty/wrong keys already in the process
# environment (a common cause of "keys missing" when .env is actually filled in).
load_dotenv(_ENV_FILE, override=True)
_cwd_env = Path.cwd() / ".env"
if _cwd_env.resolve() != _ENV_FILE.resolve():
    load_dotenv(_cwd_env, override=False)

import os

import yfinance as yf
from alpaca.common.exceptions import APIError, RetryException
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, OrderType, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import (
    GetOrdersRequest,
    MarketOrderRequest,
    StopOrderRequest,
    TrailingStopOrderRequest,
)

from rating_engine.ai_rating import rating_for_ticker
from scanner import get_finviz_watchlist

logger = logging.getLogger(__name__)

STRONG_BUY = "Strong Buy"
# Worst → best; used with ENTRY_MIN_RATING (e.g. Buy → enter on Buy or Strong Buy).
_RATING_LADDER: tuple[str, ...] = (
    "Strong Sell",
    "Sell",
    "Hold",
    "Buy",
    "Strong Buy",
)
POSITION_PCT_EQUITY = 0.05
TRAIL_PCT = 5.0
MAX_CONCURRENT_POSITIONS = int(os.environ.get("MAX_CONCURRENT_POSITIONS", "20"))
MIN_NOTIONAL_USD = 1.0
BASELINE_SPY_PATH = ROOT / ".portfolio_spy_baseline.json"
SPY_LAST_GOOD_PATH = ROOT / ".spy_last_good_close.json"
PENDING_ORDERS_PATH = ROOT / ".pending_orders.json"
DEFAULT_STATS_CSV = ROOT / "portfolio_stats.csv"
FILL_POLL_SEC = 2.0
FILL_POLL_ATTEMPTS = 15
# Pause between yfinance-heavy ML calls to reduce Yahoo throttling (seconds).
YF_THROTTLE_AFTER_TICKER = float(os.environ.get("YF_THROTTLE_SEC", "1.0"))


def _loop_timezone() -> ZoneInfo:
    """Local system TZ unless LOOP_TIMEZONE is set (e.g. America/Los_Angeles)."""
    raw = os.environ.get("LOOP_TIMEZONE", "").strip()
    if raw:
        return ZoneInfo(raw)
    return datetime.now().astimezone().tzinfo  # type: ignore[return-value]


def _parse_loop_local_hours(raw: str | None) -> tuple[int, int] | None:
    """
    Parse inclusive local hour range, e.g. ``6-13`` → 6am through 1pm (hour 13).
    Returns None if unset.
    """
    s = (raw or "").strip()
    if not s:
        return None
    if "-" not in s:
        raise ValueError(f"LOOP_LOCAL_HOURS must be START-END (e.g. 6-13), got {s!r}")
    a, b = s.split("-", 1)
    start_h = int(a.strip())
    end_h = int(b.strip())
    if not (0 <= start_h <= 23 and 0 <= end_h <= 23):
        raise ValueError("LOOP_LOCAL_HOURS hours must be 0–23")
    return start_h, end_h


def _in_loop_local_hours(now: datetime, hours: tuple[int, int]) -> bool:
    start_h, end_h = hours
    h = now.astimezone(_loop_timezone()).hour
    if start_h <= end_h:
        return start_h <= h <= end_h
    # Overnight window (e.g. 22-6)
    return h >= start_h or h <= end_h


def _seconds_until_loop_window_opens(now: datetime, hours: tuple[int, int]) -> float:
    """Sleep duration until the next local window start (hour ``start_h``, minute 0)."""
    tz = _loop_timezone()
    local = now.astimezone(tz)
    start_h, end_h = hours
    if _in_loop_local_hours(now, hours):
        return 0.0
    target = local.replace(hour=start_h, minute=0, second=0, microsecond=0)
    if start_h <= end_h:
        if local.hour > end_h:
            target += timedelta(days=1)
        # else local.hour < start_h → target is today (already correct)
    else:
        # Overnight: if between end_h+1 and start_h-1, target is today or tomorrow
        if local.hour > end_h and local.hour < start_h:
            pass  # target today
        elif local.hour > end_h:
            target += timedelta(days=1)
    if target <= local:
        target += timedelta(days=1)
    return max(0.0, (target - local).total_seconds())


def _format_loop_hours(hours: tuple[int, int]) -> str:
    start_h, end_h = hours
    return f"{start_h:02d}:00–{end_h:02d}:59 local"


def _normalize_entry_min_rating(raw: str | None) -> str:
    """ENTRY_MIN_RATING: minimum ML label that qualifies for a new long (default Strong Buy)."""
    s = (raw or STRONG_BUY).strip()
    if not s:
        return STRONG_BUY
    for label in _RATING_LADDER:
        if label.lower() == s.lower():
            return label
    logger.warning(
        "Unknown ENTRY_MIN_RATING=%r — use one of %s; using Strong Buy",
        raw,
        ", ".join(_RATING_LADDER),
    )
    return STRONG_BUY


def _rating_at_or_above_minimum(rating: object, minimum_label: str) -> bool:
    if not isinstance(rating, str):
        return False
    r = rating.strip()
    if r not in _RATING_LADDER or minimum_label not in _RATING_LADDER:
        return False
    return _RATING_LADDER.index(r) >= _RATING_LADDER.index(minimum_label)


def _wl(i: int, n: int, symbol: str) -> str:
    """Left prefix for watchlist progress lines (aligned index)."""
    w = max(2, len(str(n)))
    return f"[{i:>{w}}/{n}] {symbol:<6}"


def _score_snippet(out: dict) -> str:
    """0–100 model score from rating_for_ticker (for terminal visibility)."""
    s = out.get("score")
    if s is None:
        return "score=—"
    try:
        return f"score={int(s)}"
    except (TypeError, ValueError):
        return f"score={s!r}"


def _order_status_value(status: object) -> str:
    if status is None:
        return ""
    return str(getattr(status, "value", status)).lower()


def _filled_qty_from_order(od: object) -> float:
    fq = getattr(od, "filled_qty", None)
    if fq is None:
        return 0.0
    return float(fq)


def _order_terminal_failed(od: object) -> bool:
    st = _order_status_value(getattr(od, "status", None))
    return st in ("canceled", "expired", "rejected", "failed")


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )


def _alpaca_call(fn, *args, **kwargs):
    """Call an Alpaca SDK method with exponential backoff on transient errors."""
    delays = (1.0, 2.0, 4.0)
    last_exc: Exception | None = None
    for attempt, delay in enumerate(delays, start=1):
        try:
            return fn(*args, **kwargs)
        except APIError as e:
            sc = e.status_code
            if sc is not None and sc < 500:
                raise  # 4xx = client error, don't retry
            logger.warning("Alpaca API error (attempt %d/%d, status=%s): %s", attempt, len(delays) + 1, sc, e)
            last_exc = e
        except (RetryException, OSError) as e:
            logger.warning("Alpaca transient error (attempt %d/%d): %s", attempt, len(delays) + 1, e)
            last_exc = e
        time.sleep(delay)
    try:
        return fn(*args, **kwargs)
    except Exception:
        if last_exc is not None:
            logger.error("Alpaca call failed after %d attempts", len(delays) + 1)
        raise


def _env_nonempty(*names: str) -> str | None:
    """First defined, non-empty env value among ``names`` (after strip / simple quote trim)."""
    for n in names:
        raw = os.environ.get(n)
        if raw is None:
            continue
        s = str(raw).strip().strip("'\"")
        if s:
            return s
    return None


def _try_trading_client(*, dry_run: bool) -> TradingClient | None:
    key = _env_nonempty(
        "APCA_API_KEY_ID",
        "ALPACA_API_KEY_ID",
    )
    secret = _env_nonempty(
        "APCA_API_SECRET_KEY",
        "ALPACA_API_SECRET_KEY",
    )
    if key and secret:
        paper = os.environ.get("ALPACA_PAPER", "true").strip().lower() in ("1", "true", "yes")
        return TradingClient(key, secret, paper=paper)
    if dry_run:
        logger.warning(
            "Alpaca keys not set — using offline dry-run only (DRY_RUN_EQUITY, no broker API). "
            "Add APCA_API_KEY_ID and APCA_API_SECRET_KEY to %s (see .env.example).",
            _ENV_FILE,
        )
        return None
    hint = (
        f"Expected file: {_ENV_FILE} (exists={_ENV_FILE.is_file()}). "
        "Use exact names from Alpaca Paper dashboard → Generate API Keys: "
        "APCA_API_KEY_ID and APCA_API_SECRET_KEY (no spaces around '='; non-empty values). "
        "If you ever exported empty keys in this terminal, run: unset APCA_API_KEY_ID APCA_API_SECRET_KEY. "
        "Or run: python main.py --dry-run"
    )
    raise RuntimeError(
        "Alpaca API keys missing or empty in the environment. " + hint
    )


def _position_map(client: TradingClient) -> dict[str, float]:
    out: dict[str, float] = {}
    for p in _alpaca_call(client.get_all_positions):
        sym = str(p.symbol).upper()
        out[sym] = float(p.qty)
    return out


def _long_position_count(positions: dict[str, float]) -> int:
    """Count symbols with a positive long quantity (plan: cap concurrent positions)."""
    return sum(1 for q in positions.values() if q > 0)


def _is_whole_share_qty(qty: float) -> bool:
    """True if qty is an integer share count (Alpaca allows GTC trailing stops for whole shares only)."""
    return abs(qty - round(qty)) < 1e-5


_PROTECTIVE_EXIT_ORDER_TYPES = frozenset(
    {
        OrderType.TRAILING_STOP,
        OrderType.STOP,
        OrderType.STOP_LIMIT,
    }
)


def _has_open_protective_sell(client: TradingClient, symbol: str) -> bool:
    """Any open protective SELL (trailing / stop / stop-limit) for this symbol."""
    req = GetOrdersRequest(
        status=QueryOrderStatus.OPEN,
        symbols=[symbol],
        side=OrderSide.SELL,
    )
    try:
        orders = _alpaca_call(client.get_orders, filter=req)
    except Exception as e:
        logger.warning("Could not list open orders for %s: %s", symbol, e)
        return False
    for o in orders:
        if o.type in _PROTECTIVE_EXIT_ORDER_TYPES:
            return True
    return False


def _reference_price_for_long_stop(client: TradingClient, symbol: str) -> float | None:
    """Use Alpaca position mark; avoids an extra market-data client."""
    try:
        pos = _alpaca_call(client.get_open_position, symbol)
    except Exception as e:
        logger.warning("get_open_position %s: %s", symbol, e)
        return None
    for attr in ("current_price", "avg_entry_price"):
        raw = getattr(pos, attr, None)
        if raw is None:
            continue
        v = float(raw)
        if v > 0:
            return v
    return None


def _fixed_stop_price_below_reference(ref: float, trail_pct: float) -> float:
    """Long protective stop: trail_pct% below reference (approximates initial trailing distance)."""
    return max(0.01, round(ref * (1.0 - trail_pct / 100.0), 2))


def ensure_trailing_stop_for_long(
    client: TradingClient,
    symbol: str,
    qty: float,
    *,
    dry_run: bool,
) -> None:
    """
    Protective exit for a long: GTC trailing stop when qty is whole shares.

    Fractional positions cannot use trailing_stop on Alpaca; we submit a fixed ``stop`` sell
    at TRAIL_PCT below the position reference price (DAY), which is not a true trailing stop.
    """
    if qty <= 0:
        return
    if _has_open_protective_sell(client, symbol):
        logger.debug("Protective exit order already open for %s", symbol)
        return

    if _is_whole_share_qty(qty):
        trail_req = TrailingStopOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.SELL,
            time_in_force=TimeInForce.GTC,
            trail_percent=TRAIL_PCT,
        )
        if dry_run:
            logger.info(
                "[dry-run] Trailing stop sell %s qty=%s trail_percent=%s GTC",
                symbol,
                qty,
                TRAIL_PCT,
            )
            return
        _alpaca_call(client.submit_order, order_data=trail_req)
        logger.info(
            "Submitted trailing stop sell %s qty=%s trail_percent=%s%% tif=gtc",
            symbol,
            qty,
            TRAIL_PCT,
        )
        return

    ref = _reference_price_for_long_stop(client, symbol)
    if ref is None:
        ref = _yf_last_price(symbol)
    if ref is None or ref <= 0:
        logger.error(
            "Cannot place fractional protective stop for %s: no reference price (Alpaca position or yfinance).",
            symbol,
        )
        return

    stop_px = _fixed_stop_price_below_reference(ref, TRAIL_PCT)
    if stop_px >= ref:
        logger.error(
            "Computed stop_price=%.4f not below reference=%.4f for %s; skip stop order.",
            stop_px,
            ref,
            symbol,
        )
        return

    stop_req = StopOrderRequest(
        symbol=symbol,
        qty=qty,
        side=OrderSide.SELL,
        time_in_force=TimeInForce.DAY,
        stop_price=stop_px,
    )
    if dry_run:
        logger.info(
            "[dry-run] Fractional long %s: stop sell qty=%s stop_price=%.2f (~%.1f%% below ref %.2f) DAY "
            "(Alpaca has no fractional trailing_stop)",
            symbol,
            qty,
            stop_px,
            TRAIL_PCT,
            ref,
        )
        return
    _alpaca_call(client.submit_order, order_data=stop_req)
    logger.info(
        "Submitted stop sell %s qty=%s stop_price=%.2f (~%.1f%% below ref %.2f) tif=day "
        "(fractional long; trailing_stop not supported)",
        symbol,
        qty,
        stop_px,
        TRAIL_PCT,
        ref,
    )


def _yf_last_price(symbol: str) -> float | None:
    try:
        hist = yf.Ticker(symbol).history(period="5d", auto_adjust=True)
        if hist is not None and not hist.empty and "Close" in hist.columns:
            v = float(hist["Close"].iloc[-1])
            return v if v > 0 else None
    except Exception as e:
        logger.debug("yfinance last for %s: %s", symbol, e)
    return None


def ensure_all_longs_have_trailing_stops(
    client: TradingClient,
    positions: dict[str, float],
    *,
    dry_run: bool,
) -> None:
    for sym, qty in positions.items():
        try:
            ensure_trailing_stop_for_long(client, sym, qty, dry_run=dry_run)
        except Exception as e:
            logger.error("Failed protective exit order for %s: %s", sym, e)


def _load_pending_orders() -> list[dict]:
    try:
        if not PENDING_ORDERS_PATH.is_file():
            return []
        return json.loads(PENDING_ORDERS_PATH.read_text())
    except Exception as e:
        logger.warning("Could not read pending orders log: %s", e)
        return []


def _save_pending_orders(orders: list[dict]) -> None:
    """Atomic write via temp-file rename to avoid corrupt state on crash."""
    try:
        tmp = PENDING_ORDERS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(orders, indent=2))
        tmp.replace(PENDING_ORDERS_PATH)
    except OSError as e:
        logger.warning("Could not save pending orders log: %s", e)


def _append_pending_order(symbol: str, order_id: str, notional: float) -> None:
    orders = _load_pending_orders()
    orders.append({
        "symbol": symbol,
        "order_id": order_id,
        "notional": notional,
        "submitted_at_utc": datetime.now(timezone.utc).isoformat(),
    })
    _save_pending_orders(orders)


def _remove_pending_order(order_id: str) -> None:
    orders = [o for o in _load_pending_orders() if o.get("order_id") != order_id]
    _save_pending_orders(orders)


def reconcile_pending_orders(client: TradingClient) -> set[str]:
    """
    At startup: check each logged pending order against Alpaca.

    Returns symbols with still-open (in-flight) orders so the ML loop skips re-buying them.
    Filled and terminal-failed orders are removed from the log.
    """
    orders = _load_pending_orders()
    if not orders:
        return set()

    still_open: set[str] = set()
    to_remove: list[str] = []

    for entry in orders:
        oid = entry.get("order_id", "")
        sym = entry.get("symbol", "?")
        if not oid:
            continue
        try:
            od = _alpaca_call(client.get_order_by_id, oid)
            st = _order_status_value(getattr(od, "status", None))
            fq = _filled_qty_from_order(od)
            if fq > 0 or st == "filled":
                logger.info(
                    "Order recovery: %s order %s was filled (qty=%.6f) — position should be present",
                    sym, oid, fq,
                )
                to_remove.append(oid)
            elif _order_terminal_failed(od):
                logger.warning(
                    "Order recovery: %s order %s ended in status=%s — was not filled",
                    sym, oid, st,
                )
                to_remove.append(oid)
            else:
                logger.warning(
                    "Order recovery: %s order %s still in status=%s — skipping re-buy this run",
                    sym, oid, st,
                )
                still_open.add(sym)
                to_remove.append(oid)
        except Exception as e:
            logger.warning("Order recovery: could not fetch order %s for %s: %s", oid, sym, e)
            still_open.add(sym)

    remaining = [o for o in orders if o.get("order_id") not in to_remove]
    _save_pending_orders(remaining)
    return still_open


def try_force_buy_entry(
    client: TradingClient,
    symbol: str | None,
    *,
    dry_run: bool,
) -> None:
    """
    One notional market buy at POSITION_PCT_EQUITY of equity + trailing stop, skipping ML.
    Respects max concurrent positions, existing long, and buying power (same gates as ML path).
    """
    if not symbol:
        return
    sym = symbol.strip().upper()
    if not sym:
        return
    positions = _position_map(client)
    if sym in positions and positions[sym] > 0:
        logger.info("Force-buy: already long %s; skip.", sym)
        return
    if _long_position_count(positions) >= MAX_CONCURRENT_POSITIONS:
        logger.warning(
            "Force-buy: max concurrent positions (%d) reached; skip %s.",
            MAX_CONCURRENT_POSITIONS,
            sym,
        )
        return
    account = _alpaca_call(client.get_account)
    equity_now = float(account.equity)
    target_notional = equity_now * POSITION_PCT_EQUITY
    buying_power = float(account.buying_power)
    if target_notional > buying_power:
        logger.warning(
            "Force-buy skip %s: need %.2f USD (5%% equity) but buying_power=%.2f",
            sym,
            target_notional,
            buying_power,
        )
        return
    logger.info(
        "Force-buy: %s — entering %.2f USD (5%% of equity %.2f) (ML skipped)",
        sym,
        target_notional,
        equity_now,
    )
    ok, shares_bought = submit_strong_buy_entry(client, sym, target_notional, dry_run=dry_run)
    if ok:
        q = shares_bought if shares_bought > 0 else _position_map(client).get(sym, 0.0)
        if q > 0:
            ensure_trailing_stop_for_long(client, sym, q, dry_run=dry_run)
        elif dry_run:
            logger.info(
                "[dry-run] After fill would submit trailing stop SELL %s trail_percent=%s%% (DAY if fractional qty)",
                sym,
                TRAIL_PCT,
            )


def submit_strong_buy_entry(
    client: TradingClient,
    symbol: str,
    notional_usd: float,
    *,
    dry_run: bool,
) -> tuple[bool, float]:
    """
    Submit a notional market BUY (DAY; Alpaca fractional rule), poll for filled_qty, return (success, shares_bought).

    Trailing-stop placement should use the returned share count (falls back to position qty if needed).
    """
    if notional_usd < MIN_NOTIONAL_USD:
        logger.info("Skip %s: notional %.2f below minimum", symbol, notional_usd)
        return False, 0.0
    # Notional market buys are fractional-style; Alpaca requires DAY (GTC → 422 fractional orders).
    mkt = MarketOrderRequest(
        symbol=symbol,
        notional=round(notional_usd, 2),
        side=OrderSide.BUY,
        time_in_force=TimeInForce.DAY,
    )
    if dry_run:
        logger.info("[dry-run] Market BUY %s notional=%.2f DAY", symbol, notional_usd)
        return True, 0.0

    placed = _alpaca_call(client.submit_order, order_data=mkt)
    oid = str(getattr(placed, "id", placed))
    logger.info("Submitted market BUY %s notional=%.2f DAY order_id=%s", symbol, notional_usd, oid)
    _append_pending_order(symbol, oid, notional_usd)

    for _ in range(FILL_POLL_ATTEMPTS):
        time.sleep(FILL_POLL_SEC)
        try:
            od = _alpaca_call(client.get_order_by_id, oid)
        except Exception as e:
            logger.warning("get_order_by_id %s: %s", oid, e)
            continue
        if _order_terminal_failed(od):
            logger.warning(
                "Buy order %s for %s ended in status=%s",
                oid,
                symbol,
                _order_status_value(getattr(od, "status", None)),
            )
            _remove_pending_order(oid)
            return False, 0.0
        fq = _filled_qty_from_order(od)
        if fq > 0:
            logger.info("Buy fill %s: filled_qty=%.6f status=%s", symbol, fq, _order_status_value(od.status))
            _remove_pending_order(oid)
            return True, fq

    pos_qty = _position_map(client).get(symbol, 0.0)
    if pos_qty > 0:
        logger.info("Using position qty=%.6f for %s (order poll did not report fill yet)", pos_qty, symbol)
        _remove_pending_order(oid)
        return True, pos_qty
    logger.warning("Buy for %s: no filled_qty and no position after wait; check Alpaca console.", symbol)
    # Order remains in pending log — reconcile_pending_orders will resolve it on next startup.
    return False, 0.0


def _fetch_spy_last_close() -> float | None:
    """Last SPY daily close; None if all attempts fail (often yfinance rate limits after many tickers)."""
    periods = ("1mo", "5d", "3mo", "6mo", "1y", "2y", "max")
    try:
        for attempt in range(3):
            for per in periods:
                try:
                    hist = yf.Ticker("SPY").history(period=per, auto_adjust=True)
                except Exception as e:
                    logger.debug("SPY history(%s): %s", per, e)
                    continue
                if hist is not None and not hist.empty and "Close" in hist.columns:
                    px = float(hist["Close"].iloc[-1])
                    if px > 0:
                        return px
            if attempt < 2:
                time.sleep(2.0 * (attempt + 1))
    except Exception as e:
        logger.warning("SPY fetch unexpected error: %s", e)
    return None


def _load_last_good_spy_close() -> float | None:
    try:
        if not SPY_LAST_GOOD_PATH.is_file():
            return None
        d = json.loads(SPY_LAST_GOOD_PATH.read_text())
        v = float(d.get("close", 0) or 0)
        return v if v > 0 else None
    except Exception:
        return None


def _save_last_good_spy_close(px: float) -> None:
    try:
        SPY_LAST_GOOD_PATH.write_text(
            json.dumps(
                {"close": px, "captured_at_utc": datetime.now(timezone.utc).isoformat()},
                indent=2,
            )
        )
    except OSError as e:
        logger.debug("Could not persist last-good SPY: %s", e)


def prime_spy_benchmark(initial_capital: float) -> float | None:
    """
    Fetch SPY before any watchlist-driven yfinance calls (reduces benchmark failure from throttling).
    Ensures baseline JSON exists on first run; caches last good close for fallbacks.
    """
    px: float | None = None
    try:
        px = _fetch_spy_last_close()
    except Exception as e:
        logger.warning("SPY prime fetch raised (will try cache): %s", e)
    if px is None:
        px = _load_last_good_spy_close()
    if px is None or px <= 0:
        logger.error("SPY benchmark priming failed: no live or cached close.")
        return None
    _save_last_good_spy_close(px)
    if not BASELINE_SPY_PATH.is_file():
        BASELINE_SPY_PATH.write_text(
            json.dumps(
                {
                    "spy_price": px,
                    "initial_capital": float(initial_capital),
                    "captured_at_utc": datetime.now(timezone.utc).isoformat(),
                },
                indent=2,
            )
        )
        logger.info("Created SPY baseline at %.4f for buy-and-hold comparison.", px)
    logger.info("SPY benchmark primed at %.4f (before watchlist / ML loop).", px)
    return px


def spy_equivalent_value(
    initial_capital: float,
    *,
    spy_anchor: float | None = None,
) -> tuple[float, float]:
    """
    Returns (spy_equivalent_value, spy_last_close).

    buy-and-hold: initial_capital * (SPY_now / SPY_baseline).

    Never raises: on total failure returns (initial_capital, nan).
    Resolution order for SPY_now: fresh fetch → same-run anchor → disk cache → baseline file.
    """
    spy_now: float | None = None
    try:
        spy_now = _fetch_spy_last_close()
    except Exception as e:
        logger.warning("SPY end fetch raised: %s", e)
    if spy_now is None or spy_now <= 0:
        if spy_anchor is not None and spy_anchor > 0:
            spy_now = spy_anchor
            logger.warning("Using start-of-run SPY anchor %.4f for benchmark (end fetch failed).", spy_anchor)
    if spy_now is None or spy_now <= 0:
        spy_now = _load_last_good_spy_close()
        if spy_now and spy_now > 0:
            logger.warning("Using last-good cached SPY close %.4f for benchmark.", spy_now)
    if spy_now is None or spy_now <= 0:
        if BASELINE_SPY_PATH.is_file():
            try:
                raw = json.loads(BASELINE_SPY_PATH.read_text())
                spy_now = float(raw["spy_price"])
                logger.warning(
                    "SPY still unavailable; using baseline SPY price %.4f (flat benchmark for this row).",
                    spy_now,
                )
            except Exception:
                spy_now = None
    if spy_now is None or spy_now <= 0:
        logger.error(
            "Could not resolve SPY for benchmark; logging spy_equivalent_value=%.2f (no SPY move).",
            float(initial_capital),
        )
        return float(initial_capital), float("nan")

    _save_last_good_spy_close(spy_now)

    if BASELINE_SPY_PATH.is_file():
        raw = json.loads(BASELINE_SPY_PATH.read_text())
        base_px = float(raw["spy_price"])
        base_cap = float(raw.get("initial_capital", initial_capital))
    else:
        base_px = spy_now
        base_cap = float(initial_capital)
        BASELINE_SPY_PATH.write_text(
            json.dumps(
                {
                    "spy_price": base_px,
                    "initial_capital": base_cap,
                    "captured_at_utc": datetime.now(timezone.utc).isoformat(),
                },
                indent=2,
            )
        )
        logger.info("Created SPY baseline at %.4f for buy-and-hold comparison.", base_px)

    equiv = base_cap * (spy_now / base_px)
    return equiv, spy_now


def append_portfolio_stats(
    path: Path,
    *,
    total_portfolio_value: float,
    spy_equivalent: float,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not path.is_file()
    ts = datetime.now(timezone.utc).isoformat()
    with path.open("a", newline="") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(["timestamp_utc", "total_portfolio_value", "spy_equivalent_value"])
        w.writerow(
            [
                ts,
                f"{total_portfolio_value:.2f}",
                f"{spy_equivalent:.2f}",
            ]
        )
    logger.info("Appended stats to %s", path)
    maybe_push_stats_to_dashboard(
        timestamp_utc=ts,
        total_portfolio_value=total_portfolio_value,
        spy_equivalent=spy_equivalent,
    )


def _https_ssl_context() -> ssl.SSLContext:
    """CA bundle for urllib HTTPS (macOS Python often lacks system certs until Install Certificates)."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def maybe_push_stats_to_dashboard(
    *,
    timestamp_utc: str,
    total_portfolio_value: float,
    spy_equivalent: float,
) -> None:
    """
    Optional: POST the new row to a remote dashboard (e.g. Fly) when
    DASHBOARD_STATS_PUSH_URL and DASHBOARD_STATS_TOKEN are set in .env.
    """
    url = os.environ.get("DASHBOARD_STATS_PUSH_URL", "").strip()
    token = os.environ.get("DASHBOARD_STATS_TOKEN", "").strip()
    if not url:
        return
    if not token:
        logger.warning(
            "DASHBOARD_STATS_PUSH_URL is set but DASHBOARD_STATS_TOKEN is missing; skip remote stats push"
        )
        return
    payload = json.dumps(
        {
            "timestamp_utc": timestamp_utc,
            "total_portfolio_value": total_portfolio_value,
            "spy_equivalent_value": spy_equivalent,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Stats-Token": token,
        },
    )
    ctx = _https_ssl_context() if url.lower().startswith("https://") else None
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            if resp.status >= 400:
                logger.warning("Dashboard stats push HTTP %s", resp.status)
            else:
                logger.info("Pushed stats row to dashboard (%s)", url)
    except urllib.error.HTTPError as e:
        logger.warning("Dashboard stats push failed: HTTP %s %s", e.code, e.reason)
    except ssl.SSLError as e:
        logger.warning(
            "Dashboard stats push failed (SSL): %s — run: pip install certifi "
            "(or macOS: open the Python Install Certificates.command in your venv)",
            e,
        )
    except OSError as e:
        logger.warning("Dashboard stats push failed: %s", e)


def run(
    *,
    dry_run: bool,
    stats_csv: Path,
    watchlist_limit: int,
    ml_period: str,
    force_buy: str | None,
) -> None:
    initial_capital = float(os.environ.get("INITIAL_CAPITAL", "100000"))
    # SPY first — before dozens of per-ticker yfinance calls (rate-limit friendly).
    spy_anchor = prime_spy_benchmark(initial_capital)
    entry_min = _normalize_entry_min_rating(os.environ.get("ENTRY_MIN_RATING"))

    client = _try_trading_client(dry_run=dry_run)
    if client is None:
        equity_sim = float(os.environ.get("DRY_RUN_EQUITY", "100000"))
        logger.info("Offline dry-run: simulated equity=%.2f", equity_sim)
        logger.info("ML entry threshold: %s or better", entry_min)
        fb = (force_buy or "").strip().upper()
        if fb:
            target = equity_sim * POSITION_PCT_EQUITY
            logger.info(
                "[offline dry-run] --force-buy %s: would market BUY notional=%.2f (5%% of %.2f) "
                "then %.1f%% trailing stop (DAY if fractional qty; set Alpaca keys to send real orders).",
                fb,
                target,
                equity_sim,
                TRAIL_PCT,
            )
        tickers = get_finviz_watchlist(limit=watchlist_limit)
        dry_run_positions: set[str] = set()
        if not tickers:
            logger.warning("Empty Finviz watchlist.")
        else:
            logger.info("Watchlist size=%d", len(tickers))
            logger.info(
                "Watchlist head: %s",
                ", ".join(tickers[: min(25, len(tickers))]),
            )
            logger.info("--- watchlist ML pass (%d tickers) ---", len(tickers))
        n_wl = len(tickers)
        for i, sym_raw in enumerate(tickers, start=1):
            sym = sym_raw.strip().upper()
            if not sym:
                continue
            try:
                if sym in dry_run_positions:
                    logger.info("%s | already in sim portfolio — skip", _wl(i, n_wl, sym))
                    continue
                if len(dry_run_positions) >= MAX_CONCURRENT_POSITIONS:
                    logger.info(
                        "%s | max concurrent positions (%d) — stop entries",
                        _wl(i, n_wl, sym),
                        MAX_CONCURRENT_POSITIONS,
                    )
                    break
                try:
                    out = rating_for_ticker(sym, period=ml_period, include_details=False)
                except Exception as e:
                    err = str(e).strip().replace("\n", " ")[:100]
                    logger.info("%s | ML failed — skip (%s)", _wl(i, n_wl, sym), err)
                    logger.warning("ML rating failed for %s: %s", sym, e)
                    continue
                rating = out.get("rating")
                if not _rating_at_or_above_minimum(rating, entry_min):
                    logger.info(
                        "%s | %s rating=%s — below %s — skip",
                        _wl(i, n_wl, sym),
                        _score_snippet(out),
                        rating,
                        entry_min,
                    )
                    logger.debug(
                        "%s %s rating=%s (below ENTRY_MIN_RATING=%s)",
                        sym,
                        _score_snippet(out),
                        rating,
                        entry_min,
                    )
                    continue
                target = equity_sim * POSITION_PCT_EQUITY
                dry_run_positions.add(sym)
                logger.info(
                    "%s | %s rating=%s — would BUY $%.2f (5%% of %.2f) + exits | sim %d/%d",
                    _wl(i, n_wl, sym),
                    _score_snippet(out),
                    rating,
                    target,
                    equity_sim,
                    len(dry_run_positions),
                    MAX_CONCURRENT_POSITIONS,
                )
            finally:
                if YF_THROTTLE_AFTER_TICKER > 0:
                    time.sleep(YF_THROTTLE_AFTER_TICKER)
        if tickers:
            logger.info("--- watchlist ML pass done ---")
        spy_equiv, _ = spy_equivalent_value(initial_capital, spy_anchor=spy_anchor)
        append_portfolio_stats(
            stats_csv,
            total_portfolio_value=equity_sim,
            spy_equivalent=spy_equiv,
        )
        return

    pending_skip = reconcile_pending_orders(client)

    account = _alpaca_call(client.get_account)
    logger.info(
        "Account equity=%.2f portfolio_value=%.2f paper=%s max_concurrent_positions=%d",
        float(account.equity),
        float(getattr(account, "portfolio_value", None) or account.equity),
        os.environ.get("ALPACA_PAPER", "true"),
        MAX_CONCURRENT_POSITIONS,
    )
    logger.info("ML entry threshold: %s or better", entry_min)

    positions = _position_map(client)
    ensure_all_longs_have_trailing_stops(client, positions, dry_run=dry_run)

    positions = _position_map(client)
    longs = {s: q for s, q in positions.items() if q > 0}
    if longs:
        parts = [f"{s} {q:g}" for s, q in sorted(longs.items())]
        shown = parts[:15]
        extra = f", … (+{len(parts) - len(shown)} more)" if len(parts) > len(shown) else ""
        logger.info("Open longs: %s%s", ", ".join(shown), extra)
    else:
        logger.info("Open longs: (none)")

    try_force_buy_entry(client, force_buy, dry_run=dry_run)

    tickers = get_finviz_watchlist(limit=watchlist_limit)
    if not tickers:
        logger.warning("Empty Finviz watchlist; skipping entries.")
    else:
        logger.info("Watchlist size=%d", len(tickers))
        logger.info(
            "Watchlist head: %s",
            ", ".join(tickers[: min(25, len(tickers))]),
        )
        logger.info("--- watchlist ML pass (%d tickers) ---", len(tickers))
        n_wl = len(tickers)
        for i, sym_raw in enumerate(tickers, start=1):
            sym = sym_raw.strip().upper()
            if not sym:
                continue
            try:
                positions = _position_map(client)
                if sym in positions and positions[sym] > 0:
                    logger.info("%s | already long — skip", _wl(i, n_wl, sym))
                    continue
                if sym in pending_skip:
                    logger.info("%s | pending open order from prior run — skip", _wl(i, n_wl, sym))
                    continue
                if _long_position_count(positions) >= MAX_CONCURRENT_POSITIONS:
                    logger.info(
                        "%s | max concurrent positions (%d) — stop entries",
                        _wl(i, n_wl, sym),
                        MAX_CONCURRENT_POSITIONS,
                    )
                    break
                try:
                    out = rating_for_ticker(sym, period=ml_period, include_details=False)
                except Exception as e:
                    err = str(e).strip().replace("\n", " ")[:100]
                    logger.info("%s | ML failed — skip (%s)", _wl(i, n_wl, sym), err)
                    logger.warning("ML rating failed for %s: %s", sym, e)
                    continue
                rating = out.get("rating")
                if not _rating_at_or_above_minimum(rating, entry_min):
                    logger.info(
                        "%s | %s rating=%s — below %s — skip",
                        _wl(i, n_wl, sym),
                        _score_snippet(out),
                        rating,
                        entry_min,
                    )
                    logger.debug(
                        "%s %s rating=%s (below ENTRY_MIN_RATING=%s)",
                        sym,
                        _score_snippet(out),
                        rating,
                        entry_min,
                    )
                    continue

                account = _alpaca_call(client.get_account)
                equity_now = float(account.equity)
                target_notional = equity_now * POSITION_PCT_EQUITY
                buying_power = float(account.buying_power)
                if target_notional > buying_power:
                    logger.info(
                        "%s | %s rating=%s — skip (need $%.2f, buying_power $%.2f)",
                        _wl(i, n_wl, sym),
                        _score_snippet(out),
                        rating,
                        target_notional,
                        buying_power,
                    )
                    continue

                logger.info(
                    "%s | %s rating=%s — entering $%.2f (5%% of equity %.2f)",
                    _wl(i, n_wl, sym),
                    _score_snippet(out),
                    rating,
                    target_notional,
                    equity_now,
                )
                ok, shares_bought = submit_strong_buy_entry(client, sym, target_notional, dry_run=dry_run)
                if ok:
                    q = shares_bought if shares_bought > 0 else _position_map(client).get(sym, 0.0)
                    if q > 0:
                        ensure_trailing_stop_for_long(client, sym, q, dry_run=dry_run)
                        logger.info(
                            "%s | %s entry done — ~%.4f sh, protective exit submitted",
                            _wl(i, n_wl, sym),
                            _score_snippet(out),
                            q,
                        )
                    elif dry_run:
                        logger.info(
                            "%s | %s [dry-run] BUY logged; would add protective exit after fill (trail/stop per Alpaca rules)",
                            _wl(i, n_wl, sym),
                            _score_snippet(out),
                        )
                    else:
                        logger.info(
                            "%s | %s BUY accepted but qty still 0 — check broker / fill",
                            _wl(i, n_wl, sym),
                            _score_snippet(out),
                        )
                else:
                    logger.info(
                        "%s | %s BUY did not complete — skip",
                        _wl(i, n_wl, sym),
                        _score_snippet(out),
                    )
            finally:
                if YF_THROTTLE_AFTER_TICKER > 0:
                    time.sleep(YF_THROTTLE_AFTER_TICKER)
        logger.info("--- watchlist ML pass done ---")

    account = _alpaca_call(client.get_account)
    total_portfolio_value = float(
        getattr(account, "portfolio_value", None) or account.equity
    )
    spy_equiv, _ = spy_equivalent_value(initial_capital, spy_anchor=spy_anchor)
    append_portfolio_stats(
        stats_csv,
        total_portfolio_value=total_portfolio_value,
        spy_equivalent=spy_equiv,
    )


def main() -> None:
    p = argparse.ArgumentParser(
        description="Alpaca paper portfolio: ML-rated entries + protective exits + stats. "
        "Relax buys with env ENTRY_MIN_RATING (e.g. Buy).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="No orders. Without Alpaca keys, uses DRY_RUN_EQUITY only (Finviz + ML still run).",
    )
    p.add_argument(
        "--stats-csv",
        type=Path,
        default=DEFAULT_STATS_CSV,
        help=f"Append performance rows here (default: {DEFAULT_STATS_CSV}).",
    )
    p.add_argument("--watchlist-limit", type=int, default=50, help="Max Finviz symbols per run.")
    p.add_argument(
        "--ml-period",
        default=os.environ.get("ML_RATING_PERIOD", "2y"),
        help="yfinance history window for feature warm-up (default 2y).",
    )
    p.add_argument(
        "--force-buy",
        metavar="SYMBOL",
        default=None,
        help=(
            "Smoke test: one market buy at 5%% equity + trailing stop, skipping ML "
            "(requires Alpaca keys; with no keys, offline dry-run only logs intent)."
        ),
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="DEBUG logging (per-ticker progress is already INFO by default).",
    )
    p.add_argument(
        "--loop-minutes",
        type=float,
        default=0.0,
        metavar="N",
        help=(
            "If N > 0, repeat the trading pass every N minutes until stopped (Ctrl+C). "
            "Each pass is independent (Finviz + ML + orders + stats append). Default 0: run once."
        ),
    )
    p.add_argument(
        "--loop-local-hours",
        default=os.environ.get("LOOP_LOCAL_HOURS", "").strip() or None,
        metavar="START-END",
        help=(
            "With --loop-minutes: only run during inclusive local hours (0–23), e.g. 6-13 for 6am–1pm. "
            "Outside the window the process sleeps until the next open. TZ: LOOP_TIMEZONE or system local."
        ),
    )
    args = p.parse_args()
    _configure_logging(args.verbose)
    if args.loop_minutes < 0:
        raise SystemExit("--loop-minutes must be >= 0")
    interval_sec = float(args.loop_minutes) * 60.0
    loop_hours: tuple[int, int] | None = None
    if args.loop_local_hours:
        try:
            loop_hours = _parse_loop_local_hours(args.loop_local_hours)
        except ValueError as e:
            raise SystemExit(str(e)) from e
        if interval_sec <= 0:
            raise SystemExit("--loop-local-hours requires --loop-minutes > 0")

    def _one_pass() -> None:
        run(
            dry_run=args.dry_run,
            stats_csv=args.stats_csv,
            watchlist_limit=args.watchlist_limit,
            ml_period=args.ml_period,
            force_buy=args.force_buy,
        )

    if interval_sec <= 0:
        try:
            _one_pass()
        except Exception:
            logger.exception("Run failed")
            sys.exit(1)
        return

    tz = _loop_timezone()
    if loop_hours:
        logger.info(
            "Loop mode: every %.1f minutes, local window %s (%s, Ctrl+C to stop)",
            args.loop_minutes,
            _format_loop_hours(loop_hours),
            getattr(tz, "key", tz),
        )
    else:
        logger.info(
            "Loop mode: repeating every %.1f minutes (Ctrl+C to stop)",
            args.loop_minutes,
        )
    while True:
        if loop_hours and not _in_loop_local_hours(datetime.now(timezone.utc), loop_hours):
            wait = _seconds_until_loop_window_opens(datetime.now(timezone.utc), loop_hours)
            wake = datetime.now(timezone.utc) + timedelta(seconds=wait)
            logger.info(
                "Outside local trading window (%s); sleeping %.0f min until %s",
                _format_loop_hours(loop_hours),
                wait / 60.0,
                wake.astimezone(tz).strftime("%Y-%m-%d %H:%M %Z"),
            )
            try:
                time.sleep(wait)
            except KeyboardInterrupt:
                logger.info("Interrupted during sleep — exiting")
                raise SystemExit(0) from None
            continue
        try:
            _one_pass()
        except KeyboardInterrupt:
            logger.info("Interrupted — exiting")
            raise SystemExit(0) from None
        except Exception:
            logger.exception("Run failed — sleeping before retry")
        try:
            time.sleep(interval_sec)
        except KeyboardInterrupt:
            logger.info("Interrupted during sleep — exiting")
            raise SystemExit(0) from None


if __name__ == "__main__":
    main()
