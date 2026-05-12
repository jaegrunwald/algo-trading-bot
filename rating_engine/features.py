"""Tabular features from daily OHLCV for ML rating (inputs only—not rule-based scores)."""

from __future__ import annotations

import numpy as np
import pandas as pd


def _rsi_series(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    return 100.0 - (100.0 / (1.0 + rs))


def _true_range(high: pd.Series, low: pd.Series, close: pd.Series) -> pd.Series:
    prev_c = close.shift(1)
    tr = pd.concat(
        [
            high - low,
            (high - prev_c).abs(),
            (low - prev_c).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr


# Bump when FEATURE_COLUMNS change; stored in model artifact for contract checks.
FEATURE_SPEC_VERSION = 3

# Minimum daily rows so the last feature row is typically finite (warm-up + ATR/MACD).
MIN_ROWS_FOR_FEATURES = 72

FEATURE_COLUMNS: list[str] = [
    "ret_1",
    "ret_5",
    "ret_10",
    "ret_20",
    "log_ret_1",
    "log_ret_5",
    "vol_20",
    "close_vs_sma20",
    "close_vs_sma50",
    "sma20_vs_sma50",
    "rsi_14",
    "vol_rel_20",
    "vol_z_20",
    "hl_range_1",
    "atr_pct_14",
    "bb_pct_b",
    "macd_hist_norm",
]


def compute_feature_frame(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """
    One row per calendar row in `ohlcv` (NaN until warm-up window filled).
    Caller adds label columns (e.g. forward return) for training only.
    """
    if "Close" not in ohlcv.columns:
        raise ValueError("OHLCV must include Close.")
    if "Volume" not in ohlcv.columns:
        raise ValueError("OHLCV must include Volume.")
    for col in ("High", "Low"):
        if col not in ohlcv.columns:
            raise ValueError(f"OHLCV must include {col} for range/ATR features.")

    c = ohlcv["Close"].astype(float)
    h = ohlcv["High"].astype(float)
    low = ohlcv["Low"].astype(float)
    v = ohlcv["Volume"].astype(float)

    out = pd.DataFrame(index=ohlcv.index)
    out["ret_1"] = c.pct_change(1)
    out["ret_5"] = c.pct_change(5)
    out["ret_10"] = c.pct_change(10)
    out["ret_20"] = c.pct_change(20)
    out["log_ret_1"] = np.log(c / c.shift(1).replace(0.0, np.nan))
    out["log_ret_5"] = np.log(c / c.shift(5).replace(0.0, np.nan))
    out["vol_20"] = out["ret_1"].rolling(20).std()

    sma20 = c.rolling(20).mean()
    sma50 = c.rolling(50).mean()
    out["close_vs_sma20"] = (c - sma20) / sma20.replace(0.0, np.nan)
    out["close_vs_sma50"] = (c - sma50) / sma50.replace(0.0, np.nan)
    out["sma20_vs_sma50"] = (sma20 - sma50) / sma50.replace(0.0, np.nan)
    out["rsi_14"] = _rsi_series(c, 14)

    vma20 = v.rolling(20).mean()
    out["vol_rel_20"] = v / vma20.replace(0.0, np.nan) - 1.0
    vstd = v.rolling(20).std()
    out["vol_z_20"] = (v - vma20) / vstd.replace(0.0, np.nan)

    out["hl_range_1"] = (h - low) / c.replace(0.0, np.nan)
    tr = _true_range(h, low, c)
    out["atr_pct_14"] = tr.rolling(14).mean() / c.replace(0.0, np.nan)

    std20 = c.rolling(20).std()
    upper = sma20 + 2.0 * std20
    lower = sma20 - 2.0 * std20
    width = (upper - lower).replace(0.0, np.nan)
    out["bb_pct_b"] = (c - lower) / width

    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal = macd_line.ewm(span=9, adjust=False).mean()
    macd_hist = macd_line - signal
    out["macd_hist_norm"] = macd_hist / c.replace(0.0, np.nan)

    out = out.replace([np.inf, -np.inf], np.nan)
    return out


def forward_return(close: pd.Series, horizon: int) -> pd.Series:
    """h-day forward simple return (training label helper). Last `horizon` rows are NaN."""
    return close.shift(-horizon) / close - 1.0
