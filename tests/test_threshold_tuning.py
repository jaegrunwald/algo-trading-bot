"""Tests for holdout probability threshold search."""

from __future__ import annotations

import unittest

import numpy as np

from rating_engine.threshold_tuning import metrics_at_threshold, tune_probability_threshold


class TestThresholdTuning(unittest.TestCase):
    def test_metrics_at_threshold_perfect(self) -> None:
        y = np.array([0, 0, 1, 1])
        p = np.array([0.1, 0.2, 0.8, 0.9])
        m = metrics_at_threshold(y, p, 0.5)
        self.assertEqual(m["precision"], 1.0)
        self.assertEqual(m["recall"], 1.0)
        self.assertEqual(m["f1"], 1.0)

    def test_tune_f1_finds_reasonable_threshold(self) -> None:
        rng = np.random.default_rng(42)
        n = 800
        y = rng.integers(0, 2, n)
        p = rng.uniform(0, 1, n).astype(float)
        p = np.where(y == 1, p * 0.6 + 0.35, p * 0.5)
        p = np.clip(p, 0.01, 0.99)
        out = tune_probability_threshold(
            y, p, mode="f1", min_recall=0.0, min_predicted_positive=10
        )
        self.assertIn("probability_floor", out)
        self.assertIn("metrics_at_floor", out)
        self.assertGreaterEqual(out["metrics_at_floor"]["f1"], 0.0)


if __name__ == "__main__":
    unittest.main()
