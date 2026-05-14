#!/usr/bin/env python3
"""
Finviz-backed watchlist used by ``main.py`` (via ``get_finviz_watchlist``).

Filters: mid+ market cap, volume over 2M, signal Top Gainers. Not the same as
``WATCHLIST_TICKERS`` in ``rating_engine/config.py`` (that list is for the Flask app).
"""

from __future__ import annotations

import argparse
import sys

from finvizfinance.screener.overview import Overview

# Finviz filter keys must match finvizfinance.util.util_dict["filter"] exactly.
FILTERS: dict[str, str] = {
    "Market Cap.": "+Mid (over $2bln)",
    "Average Volume": "Over 2M",
}
SIGNAL = "Top Gainers"
DEFAULT_LIMIT = 100


def fetch_watchlist_tickers(*, limit: int = DEFAULT_LIMIT) -> list[str]:
    """
    Return up to `limit` ticker symbols from the Finviz overview screener.

    Filters: mid+ market cap, average volume over 2M, signal Top Gainers.
    """
    overview = Overview()
    overview.set_filter(signal=SIGNAL, filters_dict=FILTERS)
    df = overview.screener_view(limit=limit, verbose=0)
    if df is None or len(df) == 0:
        return []

    ticker_col = next((c for c in df.columns if str(c).strip().lower() == "ticker"), None)
    if ticker_col is None:
        ticker_col = df.columns[0]

    raw = df[ticker_col].astype(str).str.strip().str.upper()
    tickers = [t for t in raw.tolist() if t and t != "NAN"]
    return tickers[:limit]


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
