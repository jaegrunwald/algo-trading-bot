"""Env helpers for the Flask app. Optional ``FINVIZ_PREPEND_WATCHLIST_TICKERS`` merges ``WATCHLIST_TICKERS`` into ``scripts/scanner.py`` for ``main.py``."""

import os


def get_watchlist_tickers() -> list[str]:
    raw = os.environ.get("WATCHLIST_TICKERS", "AAPL,MSFT,GOOGL")
    return [t.strip().upper() for t in raw.split(",") if t.strip()]
