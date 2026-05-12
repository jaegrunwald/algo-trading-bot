"""Tests for micro-structure + volatility-adjusted target pipeline."""

from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from rating_engine.training_features import (
    FEATURE_COLUMNS,
    MIN_ROWS_TA_PIPELINE,
    build_training_frame_from_ohlcv,
    compute_feature_matrix,
    latest_feature_row,
)


def _synth_stock(n: int = 200) -> pd.DataFrame:
    rng = np.random.default_rng(1)
    idx = pd.date_range("2015-06-01", periods=n, freq="B")
    close = 80.0 + np.cumsum(rng.normal(0, 0.35, n))
    wiggle = rng.uniform(0.002, 0.018, n)
    return pd.DataFrame(
        {
            "open": close * (1 - wiggle),
            "high": close * (1 + wiggle),
            "low": close * (1 - wiggle * 1.1),
            "close": close,
            "volume": rng.integers(500_000, 4_000_000, n).astype(float),
        },
        index=idx,
    )


class TestTrainingFeatures(unittest.TestCase):
    def test_feature_names(self) -> None:
        self.assertEqual(len(FEATURE_COLUMNS), 4)

    def test_build_frame_drops_nan_target_tail(self) -> None:
        df = _synth_stock(220)
        out = build_training_frame_from_ohlcv(df)
        self.assertFalse(out["y"].isna().any())
        self.assertEqual(out[FEATURE_COLUMNS].shape[1], 4)

    def test_latest_row_no_nan(self) -> None:
        df = _synth_stock(max(MIN_ROWS_TA_PIPELINE + 30, 200))
        row = latest_feature_row(df)
        self.assertFalse(row.isna().any().any())

    def test_compute_features_shape(self) -> None:
        df = _synth_stock(120)
        m = compute_feature_matrix(df)
        self.assertEqual(m.shape[1], 4)


if __name__ == "__main__":
    unittest.main()
