"""Pick a probability cutoff on a holdout set to improve F1 / precision (class imbalance)."""

from __future__ import annotations

from typing import Any

import numpy as np


def metrics_at_threshold(y_true: np.ndarray, proba_pos: np.ndarray, t: float) -> dict[str, float]:
    y_true = np.asarray(y_true).astype(int)
    p = np.asarray(proba_pos, dtype=float)
    y_pred = (p >= t).astype(int)
    tp = int(np.sum((y_pred == 1) & (y_true == 1)))
    fp = int(np.sum((y_pred == 1) & (y_true == 0)))
    fn = int(np.sum((y_pred == 0) & (y_true == 1)))
    tn = int(np.sum((y_pred == 0) & (y_true == 0)))
    prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    rec = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
    acc = (tp + tn) / max(1, tp + tn + fp + fn)
    spec = tn / (tn + fp) if (tn + fp) > 0 else 0.0
    bal_acc = 0.5 * (rec + spec)
    return {
        "threshold": float(t),
        "precision": float(prec),
        "recall": float(rec),
        "f1": float(f1),
        "accuracy": float(acc),
        "balanced_accuracy": float(bal_acc),
        "n_predicted_positive": int(tp + fp),
    }


def tune_probability_threshold(
    y_true: np.ndarray,
    proba_pos: np.ndarray,
    *,
    mode: str = "f1",
    min_recall: float = 0.0,
    min_precision: float = 0.0,
    min_predicted_positive: int = 25,
    n_thresholds: int = 90,
) -> dict[str, Any]:
    """
    Grid-search thresholds on holdout probabilities.

    - mode='f1': maximize F1 (optionally require min_recall / min_precision).
    - mode='precision': maximize precision subject to recall >= min_recall and support floor.
    """
    y_true = np.asarray(y_true).astype(int)
    proba_pos = np.asarray(proba_pos, dtype=float)
    lo, hi = 0.03, 0.995
    thresholds = np.linspace(lo, hi, n_thresholds)

    candidates: list[tuple[float, dict[str, float]]] = []
    for t in thresholds:
        m = metrics_at_threshold(y_true, proba_pos, float(t))
        if m["n_predicted_positive"] < min_predicted_positive:
            continue
        if m["recall"] + 1e-12 < min_recall:
            continue
        if m["precision"] + 1e-12 < min_precision:
            continue
        if mode == "f1":
            obj = m["f1"]
        elif mode == "precision":
            obj = m["precision"]
        else:
            raise ValueError(f"Unknown tune mode: {mode}")
        candidates.append((obj, m))

    if not candidates:
        # Relax minimum predicted-positive count; keep recall / precision floors.
        for t in thresholds:
            m = metrics_at_threshold(y_true, proba_pos, float(t))
            if m["recall"] + 1e-12 < min_recall:
                continue
            if m["precision"] + 1e-12 < min_precision:
                continue
            obj = m["f1"] if mode == "f1" else m["precision"]
            candidates.append((obj, m))

    if not candidates:
        t_default = 0.5
        m = metrics_at_threshold(y_true, proba_pos, t_default)
        return {
            "probability_floor": t_default,
            "mode": mode,
            "min_recall": min_recall,
            "min_precision": min_precision,
            "metrics_at_floor": m,
            "note": "No threshold satisfied constraints; using 0.5.",
        }

    best_m = max(candidates, key=lambda x: x[0])[1]
    t_star = best_m["threshold"]
    metrics = {k: round(v, 5) if isinstance(v, float) else v for k, v in best_m.items()}
    return {
        "probability_floor": t_star,
        "mode": mode,
        "min_recall": min_recall,
        "min_precision": min_precision,
        "metrics_at_floor": metrics,
    }
