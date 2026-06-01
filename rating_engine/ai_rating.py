"""Load a trained sklearn model and produce rating scores (AI path, not hand rules)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

from rating_engine.market_data import fetch_daily_history
from rating_engine.training_features import (
    FEATURE_COLUMNS,
    FEATURE_PIPELINE_ID,
    MIN_ROWS_TA_PIPELINE,
    fetch_regime_features,
    latest_feature_row,
)

_ARTIFACT: dict[str, Any] | None = None


def _adjusted_probability(p_pos: float, meta: dict[str, Any]) -> tuple[float, float | None]:
    """
    Map raw P(y=1) to a 0–1 score mass used for the public 0–100 score.

    If training saved `inference.probability_floor`, rescale excess above that floor
    so "high score" means high confidence vs the tuned operating point (better precision).

    Override: set env `RATING_PROBABILITY_FLOOR` (e.g. 0.1) to replace the artifact floor
    without retraining.
    """
    raw = os.environ.get("RATING_PROBABILITY_FLOOR", "").strip()
    if raw:
        f = float(raw)
        f = float(np.clip(f, 0.0, 0.999))
    else:
        inf = meta.get("inference") or {}
        floor = inf.get("probability_floor")
        if floor is None:
            return p_pos, None
        f = float(floor)
    denom = max(1e-6, 1.0 - f)
    adj = float(np.clip((p_pos - f) / denom, 0.0, 1.0))
    return adj, f


def _score_to_rating(score: float) -> str:
    s = int(round(score))
    if s >= 70:
        return "Strong Buy"
    if s >= 57:
        return "Buy"
    if s >= 45:
        return "Hold"
    if s >= 30:
        return "Sell"
    return "Strong Sell"


def _model_path() -> Path:
    raw = os.environ.get("RATING_MODEL_PATH", "models/rating_model.joblib")
    return Path(raw).expanduser().resolve()


def load_artifact() -> dict[str, Any]:
    """Load joblib once; artifact must be a dict with keys 'model', 'feature_columns'."""
    global _ARTIFACT
    if _ARTIFACT is not None:
        return _ARTIFACT
    path = _model_path()
    if not path.is_file():
        raise FileNotFoundError(
            f"No model at {path}. Train one with: python scripts/train_rating_model.py"
        )
    data = joblib.load(path)
    if not isinstance(data, dict) or "model" not in data or "feature_columns" not in data:
        raise ValueError("Model file must be a dict with 'model' and 'feature_columns'.")
    meta = data.get("meta") or {}
    cols = list(data["feature_columns"])

    if meta.get("feature_pipeline") != FEATURE_PIPELINE_ID:
        raise ValueError(
            f"Model was trained with a legacy pipeline (feature_pipeline={meta.get('feature_pipeline')!r}). "
            "Retrain with: python scripts/train_rating_model.py"
        )
    if cols != FEATURE_COLUMNS:
        raise ValueError(
            f"TA pipeline feature_columns mismatch. Expected {FEATURE_COLUMNS}, got {cols}."
        )
    _ARTIFACT = data
    return _ARTIFACT


def clear_model_cache() -> None:
    """Mainly for tests."""
    global _ARTIFACT
    _ARTIFACT = None


def predict_from_ohlcv(
    ohlcv: pd.DataFrame,
    *,
    regime: pd.DataFrame | None = None,
    fetch_regime_period: str | None = None,
) -> tuple[int, str, dict[str, Any]]:
    """
    Latest-row prediction: score 0–100 from positive-class probability, plus label.

    Pass ``regime`` (pre-fetched SPY/XLK DataFrame) or ``fetch_regime_period``
    (yfinance window, e.g. same period string as stock history) to supply regime context.
    """
    art = load_artifact()
    meta = art.get("meta") or {}
    model = art["model"]
    feat_cols = list(art["feature_columns"])

    if not hasattr(model, "predict_proba"):
        raise TypeError("Model must support predict_proba.")

    if len(ohlcv) < MIN_ROWS_TA_PIPELINE:
        raise ValueError(
            f"Need at least {MIN_ROWS_TA_PIPELINE} trading days for TA pipeline; "
            f"got {len(ohlcv)}. Try ?period=2y or ?period=max."
        )
    if regime is None:
        per = fetch_regime_period or str(meta.get("period") or "2y")
        regime = fetch_regime_features(period=per)
    X = latest_feature_row(ohlcv, regime)

    proba = model.predict_proba(X)[0]
    if proba.shape[0] < 2:
        raise ValueError("Classifier must be binary for this scorer.")
    p_pos = float(proba[1])
    p_adj, floor = _adjusted_probability(p_pos, meta)
    score = int(round(100.0 * np.clip(p_adj, 0.0, 1.0)))
    rating = _score_to_rating(float(score))
    details: dict[str, Any] = {
        "p_positive": round(p_pos, 4),
        "p_adjusted": round(p_adj, 4),
        "feature_columns": feat_cols,
        "model_path": str(_model_path()),
        "feature_pipeline": meta.get("feature_pipeline"),
    }
    if floor is not None:
        details["probability_floor"] = round(floor, 5)
    return score, rating, details


def rating_for_ticker(
    ticker: str, *, period: str = "1y", include_details: bool = False
) -> dict[str, Any]:
    sym = ticker.strip().upper()
    load_artifact()
    ohlcv = fetch_daily_history(sym, period=period)
    score, rating, details = predict_from_ohlcv(ohlcv, fetch_regime_period=period)
    out: dict[str, Any] = {"ticker": sym, "rating": rating, "score": score}
    if include_details:
        out["period"] = period
        out["details"] = details
    return out


def model_info() -> dict[str, Any]:
    """Metadata from loaded artifact (for GET /api/model)."""
    art = load_artifact()
    meta = dict(art.get("meta") or {})
    meta.setdefault("feature_columns", list(art["feature_columns"]))
    meta["model_path"] = str(_model_path())
    return meta
