"""
Quant-style training/inference features: volatility-adjusted target, swing-style context.

Target: close_{t+5} > close_t + 1.0 * ATR_14(t) (no fixed % hurdle).
Features: MACD histogram delta, relative volume, Bollinger width, distance from 20d high.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from ta.trend import MACD
from ta.volatility import AverageTrueRange

FEATURE_PIPELINE_ID = "ta_swing_vol_v1"

FORWARD_DAYS = 5
ATR_WINDOW = 14
ATR_TARGET_MULTIPLIER = 1.0
MACD_HIST_DIFF_LAG = 3
RELATIVE_VOLUME_WINDOW = 20
BB_WINDOW = 20
BB_STD_MULT = 2.0
LOCAL_HIGH_WINDOW = 20

MIN_ROWS_TA_PIPELINE = 90

FEATURE_COLUMNS: list[str] = [
    "macd_hist_diff_3",
    "relative_volume_20d",
    "bb_width",
    "dist_from_20d_high",
]


def normalize_ohlcv_columns(frame: pd.DataFrame) -> pd.DataFrame:
    """Map Yahoo-style columns to lowercase open/high/low/close/volume."""
    df = frame.copy()
    cols_lower = {c.lower(): c for c in df.columns}
    out = pd.DataFrame(index=df.index)
    for r in ("open", "high", "low", "close", "volume"):
        key = cols_lower.get(r)
        if key is None:
            alt = {"open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"}[r]
            if alt in df.columns:
                key = alt
            else:
                raise ValueError(f"Missing column {r!r}; columns={list(df.columns)}")
        out[r] = pd.to_numeric(df[key], errors="coerce").astype(float)
    return out


def _norm_dates(idx: pd.Index) -> pd.DatetimeIndex:
    dt = pd.to_datetime(idx)
    if getattr(dt, "tz", None) is not None:
        dt = dt.tz_convert(None)
    return pd.DatetimeIndex(dt).normalize()


def add_volatility_adjusted_target(
    close: pd.Series,
    high: pd.Series,
    low: pd.Series,
    *,
    horizon: int = FORWARD_DAYS,
    atr_window: int = ATR_WINDOW,
    atr_mult: float = ATR_TARGET_MULTIPLIER,
) -> pd.Series:
    """
    y = 1 iff close.shift(-h) > close + atr_mult * ATR(atr_window).
    Last `horizon` rows NaN (no future close).
    """
    atr = AverageTrueRange(high=high, low=low, close=close, window=atr_window).average_true_range()
    fwd_close = close.shift(-horizon)
    hurdle = close + atr_mult * atr
    y = (fwd_close > hurdle).astype(float)
    return y


def compute_feature_matrix(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """MACD delta, relative volume, Bollinger squeeze width, distance from rolling high."""
    df = normalize_ohlcv_columns(ohlcv)
    c = df["close"]
    vol = df["volume"]

    macd_hist = MACD(close=c).macd_diff()
    macd_hist_diff_3 = macd_hist.diff(MACD_HIST_DIFF_LAG)

    vma = vol.rolling(RELATIVE_VOLUME_WINDOW, min_periods=RELATIVE_VOLUME_WINDOW).mean()
    relative_volume_20d = vol / vma.replace(0.0, np.nan)

    sma_bb = c.rolling(BB_WINDOW, min_periods=BB_WINDOW).mean()
    std_bb = c.rolling(BB_WINDOW, min_periods=BB_WINDOW).std()
    upper_bb = sma_bb + BB_STD_MULT * std_bb
    lower_bb = sma_bb - BB_STD_MULT * std_bb
    bb_width = (upper_bb - lower_bb) / sma_bb.replace(0.0, np.nan)

    roll_max = c.rolling(LOCAL_HIGH_WINDOW, min_periods=LOCAL_HIGH_WINDOW).max()
    dist_from_20d_high = (c - roll_max) / roll_max.replace(0.0, np.nan)

    dates = _norm_dates(df.index)
    feats = pd.DataFrame(
        {
            "macd_hist_diff_3": macd_hist_diff_3.values,
            "relative_volume_20d": relative_volume_20d.values,
            "bb_width": bb_width.values,
            "dist_from_20d_high": dist_from_20d_high.values,
        },
        index=dates,
    )

    return feats.replace([np.inf, -np.inf], np.nan)


def build_training_frame_from_ohlcv(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """Supervised rows: FEATURE_COLUMNS + y + as_of; strict dropna on target and features."""
    df = normalize_ohlcv_columns(ohlcv)
    c, h, low = df["close"], df["high"], df["low"]

    feats = compute_feature_matrix(ohlcv)
    y = add_volatility_adjusted_target(c, h, low)

    out = feats.copy()
    out["y"] = y.values
    out["as_of"] = out.index
    out = out.dropna(subset=["y"] + FEATURE_COLUMNS)
    out["y"] = out["y"].astype(int)
    return out.reset_index(drop=True)


def latest_feature_row(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """Single-row X for the latest date (inference)."""
    if len(ohlcv) < MIN_ROWS_TA_PIPELINE:
        raise ValueError(
            f"Need at least {MIN_ROWS_TA_PIPELINE} rows; got {len(ohlcv)}. "
            "Try a longer ?period= (e.g. 2y)."
        )
    feats = compute_feature_matrix(ohlcv)
    feats = feats.dropna(subset=FEATURE_COLUMNS)
    if feats.empty:
        raise ValueError("No valid rows after feature computation.")
    return feats.iloc[[-1]][FEATURE_COLUMNS]
