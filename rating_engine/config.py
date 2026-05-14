"""Small env helpers for the Flask app (not the Finviz-driven list in ``main.py``)."""

import os


def get_watchlist_tickers() -> list[str]:
    raw = os.environ.get("WATCHLIST_TICKERS", "AAPL,MSFT,GOOGL")
    return [t.strip().upper() for t in raw.split(",") if t.strip()]
