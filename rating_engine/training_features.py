"""
Quant-style training/inference features: swing TA + market/sector context, ATR-adjusted target.

Target: close_{t+h} > close_t + m * ATR_w(t) (defaults: h=10, w=14, m=1.0).
Stock features: MACD histogram delta, relative volume, Bollinger width.
Context (merged by date): SPY returns & trend, XLK 5d return (tech sector proxy).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import yfinance as yf
from ta.trend import MACD
from ta.volatility import AverageTrueRange

FEATURE_PIPELINE_ID = "ta_swing_regime_v1"

FORWARD_DAYS = 10
ATR_WINDOW = 14
ATR_TARGET_MULTIPLIER = 1.0
MACD_HIST_DIFF_LAG = 3
RELATIVE_VOLUME_WINDOW = 20
BB_WINDOW = 20
BB_STD_MULT = 2.0
SPY_TREND_SMA = 20

MIN_ROWS_TA_PIPELINE = 60

FEATURE_COLUMNS: list[str] = [
    "macd_hist_diff_3",
    "relative_volume_20d",
    "bb_width",
    "spy_5d_return",
    "spy_20d_return",
    "spy_trend",
    "xlk_5d_return",
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


def fetch_regime_features(*, period: str) -> pd.DataFrame:
    """
    SPY + XLK (tech sector) series aligned by calendar date for merging with stocks.

    Columns: spy_5d_return, spy_20d_return, spy_trend ((SPY/SPY_SMA20)-1), xlk_5d_return.
    """
    spy_hist = yf.Ticker("SPY").history(period=period, interval="1d", auto_adjust=False)
    if spy_hist is None or spy_hist.empty:
        raise ValueError("No SPY history for regime features")
    spy_c = spy_hist["Close"].astype(float).copy()
    spy_c.index = _norm_dates(spy_c.index)
    spy_c = spy_c.groupby(spy_c.index).last()
    sma = spy_c.rolling(SPY_TREND_SMA, min_periods=SPY_TREND_SMA).mean()
    spy_trend = (spy_c / sma.replace(0.0, np.nan)) - 1.0

    out = pd.DataFrame(
        {
            "spy_5d_return": spy_c.pct_change(5),
            "spy_20d_return": spy_c.pct_change(20),
            "spy_trend": spy_trend,
        },
        index=spy_c.index,
    )

    xlk_hist = yf.Ticker("XLK").history(period=period, interval="1d", auto_adjust=False)
    if xlk_hist is not None and not xlk_hist.empty:
        xc = xlk_hist["Close"].astype(float).copy()
        xc.index = _norm_dates(xc.index)
        xc = xc.groupby(xc.index).last()
        out["xlk_5d_return"] = xc.pct_change(5).reindex(out.index).ffill()
    else:
        out["xlk_5d_return"] = np.nan

    return out.replace([np.inf, -np.inf], np.nan)


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


def compute_feature_matrix(ohlcv: pd.DataFrame, regime: pd.DataFrame) -> pd.DataFrame:
    """Stock TA + merged SPY/XLK regime (left join on normalized dates, ffill)."""
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

    dates = _norm_dates(df.index)
    feats = pd.DataFrame(
        {
            "macd_hist_diff_3": macd_hist_diff_3.values,
            "relative_volume_20d": relative_volume_20d.values,
            "bb_width": bb_width.values,
        },
        index=dates,
    )

    reg = regime.copy()
    reg.index = _norm_dates(reg.index)
    reg = reg[~reg.index.duplicated(keep="last")]
    reg_part = reg.reindex(feats.index)
    for col in ("spy_5d_return", "spy_20d_return", "spy_trend", "xlk_5d_return"):
        feats[col] = reg_part[col].values
    feats[["spy_5d_return", "spy_20d_return", "spy_trend", "xlk_5d_return"]] = feats[
        ["spy_5d_return", "spy_20d_return", "spy_trend", "xlk_5d_return"]
    ].ffill()

    return feats.replace([np.inf, -np.inf], np.nan)


def build_training_frame_from_ohlcv(
    ohlcv: pd.DataFrame,
    regime: pd.DataFrame,
    *,
    forward_days: int | None = None,
    atr_window: int | None = None,
    atr_mult: float | None = None,
) -> pd.DataFrame:
    """Supervised rows: FEATURE_COLUMNS + y + as_of; strict dropna on target and features."""
    df = normalize_ohlcv_columns(ohlcv)
    c, h, low = df["close"], df["high"], df["low"]

    hdays = int(forward_days if forward_days is not None else FORWARD_DAYS)
    awin = int(atr_window if atr_window is not None else ATR_WINDOW)
    amult = float(atr_mult if atr_mult is not None else ATR_TARGET_MULTIPLIER)

    feats = compute_feature_matrix(ohlcv, regime)
    y = add_volatility_adjusted_target(c, h, low, horizon=hdays, atr_window=awin, atr_mult=amult)

    out = feats.copy()
    out["y"] = y.values
    out["as_of"] = out.index
    out = out.dropna(subset=["y"] + FEATURE_COLUMNS)
    out["y"] = out["y"].astype(int)
    return out.reset_index(drop=True)


def latest_feature_row(ohlcv: pd.DataFrame, regime: pd.DataFrame) -> pd.DataFrame:
    """Single-row X for the latest date (inference)."""
    if len(ohlcv) < MIN_ROWS_TA_PIPELINE:
        raise ValueError(
            f"Need at least {MIN_ROWS_TA_PIPELINE} rows; got {len(ohlcv)}. "
            "Try a longer ?period= (e.g. 2y)."
        )
    feats = compute_feature_matrix(ohlcv, regime)
    feats = feats.dropna(subset=FEATURE_COLUMNS)
    if feats.empty:
        raise ValueError("No valid rows after feature computation.")
    return feats.iloc[[-1]][FEATURE_COLUMNS]
