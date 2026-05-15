#!/usr/bin/env python3
"""
Finviz-backed watchlist used by ``main.py`` (via ``get_finviz_watchlist``).

Finviz shows ~20 rows per page; ``finvizfinance`` paginates when the site exposes
multiple pages. If your filters match fewer than ``limit`` names, you only get
that many rows — raising ``--watchlist-limit`` alone does not invent tickers.

Widen / vary the pool with env (see ``.env.example``):
  FINVIZ_SIGNAL — primary overview signal (default Top Gainers), unless daily rotation is on.
  FINVIZ_EXTRA_SIGNALS — comma-separated extra signals (same filters), merged in order, deduped.
  FINVIZ_MARKET_CAP / FINVIZ_AVERAGE_VOLUME — override filter strings (defaults: mid+ cap, Over 500K volume).
  FINVIZ_ALWAYS_INCLUDE — comma-separated tickers prepended every run.
  FINVIZ_PREPEND_WATCHLIST_TICKERS — if true, prepend ``WATCHLIST_TICKERS`` (Flask list) after that; default off
    so ``main.py`` mostly discovers from Finviz.
  FINVIZ_SHUFFLE_SCREENER — if true, shuffle Finviz-sourced names before filling the rest of the cap (new mix each run).
  FINVIZ_ROTATE_SIGNAL_DAILY + FINVIZ_SIGNAL_CYCLE — e.g. cycle primary signal by calendar day for fresher screens.
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time
from datetime import datetime
from pathlib import Path

from finvizfinance.screener.overview import Overview

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
except ImportError:
    pass


def _truthy_env(name: str, *, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _filters_from_env() -> dict[str, str]:
    """Finviz filter keys must match finvizfinance.util.util_dict['filter'] exactly."""
    return {
        "Market Cap.": os.environ.get("FINVIZ_MARKET_CAP", "+Mid (over $2bln)").strip() or "+Mid (over $2bln)",
        "Average Volume": os.environ.get("FINVIZ_AVERAGE_VOLUME", "Over 500K").strip() or "Over 500K",
    }


def _primary_signal_from_env() -> str:
    if _truthy_env("FINVIZ_ROTATE_SIGNAL_DAILY"):
        raw_cycle = os.environ.get("FINVIZ_SIGNAL_CYCLE", "").strip()
        options = [s.strip() for s in raw_cycle.split(",") if s.strip()]
        if options:
            idx = datetime.now().timetuple().tm_yday % len(options)
            return options[idx]
    return os.environ.get("FINVIZ_SIGNAL", "Top Gainers").strip() or "Top Gainers"


def _signals_from_env() -> list[str]:
    primary = _primary_signal_from_env()
    raw = os.environ.get("FINVIZ_EXTRA_SIGNALS", "").strip()
    extras = [s.strip() for s in raw.split(",") if s.strip()]
    out: list[str] = []
    for s in [primary, *extras]:
        if s not in out:
            out.append(s)
    return out


def _fetch_one_signal(signal: str, filters: dict[str, str], *, limit: int) -> list[str]:
    overview = Overview()
    overview.set_filter(signal=signal, filters_dict=filters)
    df = overview.screener_view(limit=limit, verbose=0)
    if df is None or len(df) == 0:
        return []
    ticker_col = next((c for c in df.columns if str(c).strip().lower() == "ticker"), None)
    if ticker_col is None:
        ticker_col = df.columns[0]
    raw = df[ticker_col].astype(str).str.strip().str.upper()
    return [t for t in raw.tolist() if t and t != "NAN"]


DEFAULT_LIMIT = 100


def _always_include_tickers() -> list[str]:
    raw = os.environ.get("FINVIZ_ALWAYS_INCLUDE", "").strip()
    return [t.strip().upper() for t in raw.split(",") if t.strip()]


def _watchlist_tickers_from_env() -> list[str]:
    """Same list as ``rating_engine.config.get_watchlist_tickers`` (Flask); optional prepend for ``main.py``."""
    raw = os.environ.get("WATCHLIST_TICKERS", "").strip()
    return [t.strip().upper() for t in raw.split(",") if t.strip()]


def fetch_watchlist_tickers(*, limit: int = DEFAULT_LIMIT) -> list[str]:
    """
    Return up to ``limit`` ticker symbols from Finviz overview screeners.

    Order (deduped): ``FINVIZ_ALWAYS_INCLUDE``, optionally ``WATCHLIST_TICKERS`` if
    ``FINVIZ_PREPEND_WATCHLIST_TICKERS``, then Finviz signals (optionally shuffled).
    """
    if limit < 1:
        return []
    filters = _filters_from_env()
    signals = _signals_from_env()
    seen: set[str] = set()
    prefix: list[str] = []
    for t in _always_include_tickers():
        if t in seen:
            continue
        seen.add(t)
        prefix.append(t)
        if len(prefix) >= limit:
            return prefix

    if _truthy_env("FINVIZ_PREPEND_WATCHLIST_TICKERS"):
        for t in _watchlist_tickers_from_env():
            if t in seen:
                continue
            seen.add(t)
            prefix.append(t)
            if len(prefix) >= limit:
                return prefix

    finviz_syms: list[str] = []
    for sig in signals:
        for t in _fetch_one_signal(sig, filters, limit=limit):
            if t in seen:
                continue
            seen.add(t)
            finviz_syms.append(t)

    if _truthy_env("FINVIZ_SHUFFLE_SCREENER"):
        seed_raw = os.environ.get("FINVIZ_SHUFFLE_SEED", "").strip()
        rng = random.Random()
        if seed_raw.isdigit():
            rng.seed(int(seed_raw))
        else:
            rng.seed(int(time.time_ns()) % (2**32))
        rng.shuffle(finviz_syms)

    need = limit - len(prefix)
    return prefix + finviz_syms[: max(0, need)]


def get_finviz_watchlist(*, limit: int = DEFAULT_LIMIT) -> list[str]:
    """Alias for portfolio runners / cron jobs (same as fetch_watchlist_tickers)."""
    return fetch_watchlist_tickers(limit=limit)


def main() -> None:
    p = argparse.ArgumentParser(description="Finviz screener → watchlist tickers (stdout).")
    p.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"Max tickers to return (default {DEFAULT_LIMIT}).",
    )
    args = p.parse_args()
    if args.limit < 1:
        print("limit must be >= 1", file=sys.stderr)
        sys.exit(1)
    syms = fetch_watchlist_tickers(limit=args.limit)
    for s in syms:
        print(s)


if __name__ == "__main__":
    main()
