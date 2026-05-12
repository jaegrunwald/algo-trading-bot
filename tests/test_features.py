"""Unit tests for feature pipeline (no network)."""

from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from rating_engine.features import (
    FEATURE_COLUMNS,
    MIN_ROWS_FOR_FEATURES,
    compute_feature_frame,
    forward_return,
)


def _synth_ohlcv(n: int = 120) -> pd.DataFrame:
    rng = np.random.default_rng(0)
    dates = pd.date_range("2020-01-01", periods=n, freq="B")
    close = 100.0 + np.cumsum(rng.normal(0, 0.5, n))
    noise = rng.uniform(0.001, 0.015, n)
    high = close * (1.0 + noise)
    low = close * (1.0 - noise)
    volume = rng.integers(1_000_000, 5_000_000, n).astype(float)
    return pd.DataFrame(
        {"Open": close, "High": high, "Low": low, "Close": close, "Volume": volume},
        index=dates,
    )


class TestFeatures(unittest.TestCase):
    def test_feature_columns_count(self) -> None:
        self.assertEqual(len(FEATURE_COLUMNS), 17)
        self.assertIn("macd_hist_norm", FEATURE_COLUMNS)
        self.assertIn("atr_pct_14", FEATURE_COLUMNS)

    def test_compute_feature_frame_last_row_finite(self) -> None:
        raw = _synth_ohlcv(max(MIN_ROWS_FOR_FEATURES + 5, 120))
        feats = compute_feature_frame(raw)
        last = feats.iloc[-1][FEATURE_COLUMNS]
        self.assertFalse(last.isna().any(), msg=last.to_string())

    def test_forward_return_shift(self) -> None:
        raw = _synth_ohlcv(30)
        c = raw["Close"]
        h = 5
        fr = forward_return(c, h)
        self.assertTrue(np.isnan(fr.iloc[-1]))
        self.assertFalse(np.isnan(fr.iloc[-(h + 1)]))

    def test_as_of_style_index(self) -> None:
        raw = _synth_ohlcv(90)
        feats = compute_feature_frame(raw)
        self.assertIsInstance(feats.index, pd.DatetimeIndex)


if __name__ == "__main__":
    unittest.main()
