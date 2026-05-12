"""Daily historical OHLCV via Yahoo Finance (yfinance)."""

from __future__ import annotations

import pandas as pd
import yfinance as yf


def fetch_daily_history(ticker: str, *, period: str = "1y") -> pd.DataFrame:
    """
    Pull daily bars for one symbol. `period` follows yfinance (e.g. 1mo, 3mo, 1y, 5y).

    Raises ValueError if no rows are returned (invalid ticker or no data).
    """
    symbol = ticker.strip().upper()
    frame = yf.Ticker(symbol).history(period=period, interval="1d", auto_adjust=False)
    if frame is None or frame.empty:
        raise ValueError(f"No daily history returned for {symbol!r}")
    return frame


def dataframe_to_records(frame: pd.DataFrame) -> list[dict]:
    """Serialize a yfinance history DataFrame to JSON-friendly rows."""
    out = frame.reset_index()
    if "Date" in out.columns:
        out["Date"] = out["Date"].dt.strftime("%Y-%m-%d")
    elif "Datetime" in out.columns:
        out["Datetime"] = out["Datetime"].dt.strftime("%Y-%m-%d %H:%M:%S")
    return out.to_dict(orient="records")
