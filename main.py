#!/usr/bin/env python3
"""
Alpaca paper-trading runner: Finviz watchlist → ML rating → 5% equity Strong Buy entries
with 5% trailing stop exits; append performance vs SPY buy-and-hold to portfolio_stats.csv.

SPY benchmark is primed at run start (before per-ticker yfinance). Throttle sleep between tickers
via YF_THROTTLE_SEC (default 1s) to reduce Yahoo Finance rate limits.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

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
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, OrderType, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import (
    GetOrdersRequest,
    MarketOrderRequest,
    TrailingStopOrderRequest,
)

from rating_engine.ai_rating import rating_for_ticker
from scanner import get_finviz_watchlist

logger = logging.getLogger(__name__)

STRONG_BUY = "Strong Buy"
POSITION_PCT_EQUITY = 0.05
TRAIL_PCT = 5.0
MIN_NOTIONAL_USD = 1.0
BASELINE_SPY_PATH = ROOT / ".portfolio_spy_baseline.json"
SPY_LAST_GOOD_PATH = ROOT / ".spy_last_good_close.json"
DEFAULT_STATS_CSV = ROOT / "portfolio_stats.csv"
FILL_POLL_SEC = 2.0
FILL_POLL_ATTEMPTS = 15
# Pause between yfinance-heavy ML calls to reduce Yahoo throttling (seconds).
YF_THROTTLE_AFTER_TICKER = float(os.environ.get("YF_THROTTLE_SEC", "1.0"))


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
    for p in client.get_all_positions():
        sym = str(p.symbol).upper()
        out[sym] = float(p.qty)
    return out


def _has_open_trailing_stop_sell(client: TradingClient, symbol: str) -> bool:
    req = GetOrdersRequest(
        status=QueryOrderStatus.OPEN,
        symbols=[symbol],
        side=OrderSide.SELL,
    )
    try:
        orders = client.get_orders(filter=req)
    except Exception as e:
        logger.warning("Could not list open orders for %s: %s", symbol, e)
        return False
    for o in orders:
        if o.type == OrderType.TRAILING_STOP:
            return True
    return False


def ensure_trailing_stop_for_long(
    client: TradingClient,
    symbol: str,
    qty: float,
    *,
    dry_run: bool,
) -> None:
    """One GTC trailing stop sell at TRAIL_PCT off high watermark, full position qty."""
    if qty <= 0:
        return
    if _has_open_trailing_stop_sell(client, symbol):
        logger.debug("Trailing stop already open for %s", symbol)
        return
    trail_req = TrailingStopOrderRequest(
        symbol=symbol,
        qty=qty,
        side=OrderSide.SELL,
        time_in_force=TimeInForce.GTC,
        trail_percent=TRAIL_PCT,
    )
    if dry_run:
        logger.info("[dry-run] Trailing stop sell %s qty=%s trail_percent=%s GTC", symbol, qty, TRAIL_PCT)
        return
    client.submit_order(order_data=trail_req)
    logger.info("Submitted trailing stop sell %s qty=%s trail_percent=%s%%", symbol, qty, TRAIL_PCT)


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
            logger.error("Failed trailing stop for %s: %s", sym, e)


def submit_strong_buy_entry(
    client: TradingClient,
    symbol: str,
    notional_usd: float,
    *,
    dry_run: bool,
) -> tuple[bool, float]:
    """
    Submit a notional market BUY (GTC), poll for filled_qty, return (success, shares_bought).

    Trailing-stop placement should use the returned share count (falls back to position qty if needed).
    """
    if notional_usd < MIN_NOTIONAL_USD:
        logger.info("Skip %s: notional %.2f below minimum", symbol, notional_usd)
        return False, 0.0
    mkt = MarketOrderRequest(
        symbol=symbol,
        notional=round(notional_usd, 2),
        side=OrderSide.BUY,
        time_in_force=TimeInForce.GTC,
    )
    if dry_run:
        logger.info("[dry-run] Market BUY %s notional=%.2f GTC", symbol, notional_usd)
        return True, 0.0

    placed = client.submit_order(order_data=mkt)
    oid = getattr(placed, "id", placed)
    logger.info("Submitted market BUY %s notional=%.2f GTC order_id=%s", symbol, notional_usd, oid)

    for _ in range(FILL_POLL_ATTEMPTS):
        time.sleep(FILL_POLL_SEC)
        try:
            od = client.get_order_by_id(oid)
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
            return False, 0.0
        fq = _filled_qty_from_order(od)
        if fq > 0:
            logger.info("Buy fill %s: filled_qty=%.6f status=%s", symbol, fq, _order_status_value(od.status))
            return True, fq

    pos_qty = _position_map(client).get(symbol, 0.0)
    if pos_qty > 0:
        logger.info("Using position qty=%.6f for %s (order poll did not report fill yet)", pos_qty, symbol)
        return True, pos_qty
    logger.warning("Buy for %s: no filled_qty and no position after wait; check Alpaca console.", symbol)
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
    with path.open("a", newline="") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(["timestamp_utc", "total_portfolio_value", "spy_equivalent_value"])
        w.writerow(
            [
                datetime.now(timezone.utc).isoformat(),
                f"{total_portfolio_value:.2f}",
                f"{spy_equivalent:.2f}",
            ]
        )
    logger.info("Appended stats to %s", path)


def run(
    *,
    dry_run: bool,
    stats_csv: Path,
    watchlist_limit: int,
    ml_period: str,
) -> None:
    initial_capital = float(os.environ.get("INITIAL_CAPITAL", "100000"))
    # SPY first — before dozens of per-ticker yfinance calls (rate-limit friendly).
    spy_anchor = prime_spy_benchmark(initial_capital)

    client = _try_trading_client(dry_run=dry_run)
    if client is None:
        equity_sim = float(os.environ.get("DRY_RUN_EQUITY", "100000"))
        logger.info("Offline dry-run: simulated equity=%.2f", equity_sim)
        tickers = get_finviz_watchlist(limit=watchlist_limit)
        if not tickers:
            logger.warning("Empty Finviz watchlist.")
        else:
            logger.info("Watchlist size=%d", len(tickers))
        for sym in tickers:
            sym = sym.strip().upper()
            if not sym:
                continue
            try:
                try:
                    out = rating_for_ticker(sym, period=ml_period, include_details=False)
                except Exception as e:
                    logger.warning("ML rating failed for %s: %s", sym, e)
                    continue
                if out.get("rating") != STRONG_BUY:
                    logger.debug("%s rating=%s (not Strong Buy)", sym, out.get("rating"))
                    continue
                target = equity_sim * POSITION_PCT_EQUITY
                logger.info(
                    "[offline dry-run] Would BUY %s notional=%.2f (5%% of %.2f); "
                    "then place %.1f%% trailing stop GTC",
                    sym,
                    target,
                    equity_sim,
                    TRAIL_PCT,
                )
            finally:
                if YF_THROTTLE_AFTER_TICKER > 0:
                    time.sleep(YF_THROTTLE_AFTER_TICKER)
        spy_equiv, _ = spy_equivalent_value(initial_capital, spy_anchor=spy_anchor)
        append_portfolio_stats(
            stats_csv,
            total_portfolio_value=equity_sim,
            spy_equivalent=spy_equiv,
        )
        return

    account = client.get_account()
    logger.info(
        "Account equity=%.2f portfolio_value=%.2f paper=%s",
        float(account.equity),
        float(getattr(account, "portfolio_value", None) or account.equity),
        os.environ.get("ALPACA_PAPER", "true"),
    )

    positions = _position_map(client)
    ensure_all_longs_have_trailing_stops(client, positions, dry_run=dry_run)

    tickers = get_finviz_watchlist(limit=watchlist_limit)
    if not tickers:
        logger.warning("Empty Finviz watchlist; skipping entries.")
    else:
        logger.info("Watchlist size=%d", len(tickers))

    for sym in tickers:
        sym = sym.strip().upper()
        if not sym:
            continue
        try:
            positions = _position_map(client)
            if sym in positions and positions[sym] > 0:
                logger.debug("Already long %s; skip entry", sym)
                continue
            try:
                out = rating_for_ticker(sym, period=ml_period, include_details=False)
            except Exception as e:
                logger.warning("ML rating failed for %s: %s", sym, e)
                continue
            if out.get("rating") != STRONG_BUY:
                logger.debug("%s rating=%s (not Strong Buy)", sym, out.get("rating"))
                continue

            account = client.get_account()
            equity_now = float(account.equity)
            target_notional = equity_now * POSITION_PCT_EQUITY
            buying_power = float(account.buying_power)
            if target_notional > buying_power:
                logger.warning(
                    "Skip %s: need %.2f USD (5%% equity) but buying_power=%.2f",
                    sym,
                    target_notional,
                    buying_power,
                )
                continue

            logger.info(
                "Strong Buy: %s — entering %.2f USD (5%% of equity %.2f)",
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
                        "[dry-run] After fill would submit trailing stop SELL %s trail_percent=%s%% GTC",
                        sym,
                        TRAIL_PCT,
                    )
        finally:
            if YF_THROTTLE_AFTER_TICKER > 0:
                time.sleep(YF_THROTTLE_AFTER_TICKER)

    account = client.get_account()
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
    p = argparse.ArgumentParser(description="Alpaca paper portfolio: ML Strong Buy + trailing stops + stats.")
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
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()
    _configure_logging(args.verbose)
    try:
        run(
            dry_run=args.dry_run,
            stats_csv=args.stats_csv,
            watchlist_limit=args.watchlist_limit,
            ml_period=args.ml_period,
        )
    except Exception:
        logger.exception("Run failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
