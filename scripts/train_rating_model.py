#!/usr/bin/env python3
"""
Train the rating classifier: volatility-adjusted target, swing features (BB squeeze, 20d high, MACD, volume).

Target: close_{t+5} > close_t + 1.0 * ATR_14(t). Strict TimeSeriesSplit CV.
Threshold tuning: precision with min recall 0.20 on OOF probabilities.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.utils.class_weight import compute_sample_weight

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rating_engine.market_data import fetch_daily_history
from rating_engine.threshold_tuning import tune_probability_threshold
from rating_engine.training_features import (
    ATR_TARGET_MULTIPLIER,
    ATR_WINDOW,
    FEATURE_COLUMNS,
    FEATURE_PIPELINE_ID,
    FORWARD_DAYS,
    build_training_frame_from_ohlcv,
)


def _xgb_classifier(**kwargs: Any) -> Any:
    """Lazy import: avoids loading libxgboost when using default --classifier hgb."""
    try:
        from xgboost import XGBClassifier

        return XGBClassifier(**kwargs)
    except Exception as e:
        raise RuntimeError(
            "XGBoost failed to load. On macOS install OpenMP, then retry:\n"
            "  brew install libomp\n"
            "Or use the default model (no flag needed): HistGradientBoostingClassifier.\n"
            f"Original error: {e}"
        ) from e


DEFAULT_TICKERS = [
    "SPY",
    "QQQ",
    "IWM",
    "AAPL",
    "MSFT",
    "GOOGL",
    "AMZN",
    "META",
    "NVDA",
    "JPM",
    "XOM",
    "AMD",
]


def _stack_panel(
    tickers: list[str],
    *,
    period: str,
) -> pd.DataFrame:
    parts: list[pd.DataFrame] = []
    for sym in tickers:
        sym = sym.strip().upper()
        if not sym:
            continue
        raw = fetch_daily_history(sym, period=period)
        block = build_training_frame_from_ohlcv(raw)
        block["ticker"] = sym
        parts.append(block)
    if not parts:
        raise ValueError("No training data; check tickers and period.")
    panel = pd.concat(parts, axis=0, ignore_index=True)
    panel = panel.sort_values("as_of", kind="mergesort").reset_index(drop=True)
    return panel


def _make_classifier(name: str, seed: int) -> Any:
    if name == "hgb":
        return HistGradientBoostingClassifier(
            max_iter=500,
            learning_rate=0.04,
            max_depth=5,
            min_samples_leaf=80,
            max_leaf_nodes=31,
            l2_regularization=2.0,
            class_weight="balanced",
            random_state=seed,
            early_stopping=True,
            validation_fraction=0.1,
            n_iter_no_change=25,
        )
    if name == "xgb":
        return _xgb_classifier(
            n_estimators=400,
            max_depth=5,
            learning_rate=0.04,
            min_child_weight=12,
            subsample=0.85,
            colsample_bytree=0.85,
            reg_lambda=2.0,
            random_state=seed,
            n_jobs=-1,
            eval_metric="logloss",
        )
    raise ValueError(f"Unknown classifier: {name}")


def _make_classifier_final(name: str, seed: int) -> Any:
    if name == "hgb":
        return HistGradientBoostingClassifier(
            max_iter=550,
            learning_rate=0.04,
            max_depth=5,
            min_samples_leaf=70,
            max_leaf_nodes=31,
            l2_regularization=2.0,
            class_weight="balanced",
            random_state=seed,
            early_stopping=False,
        )
    if name == "xgb":
        return _xgb_classifier(
            n_estimators=500,
            max_depth=5,
            learning_rate=0.04,
            min_child_weight=10,
            subsample=0.88,
            colsample_bytree=0.88,
            reg_lambda=2.0,
            random_state=seed,
            n_jobs=-1,
            eval_metric="logloss",
        )
    raise ValueError(f"Unknown classifier: {name}")


PERMUTATION_RANDOM_STATE = 42
PERMUTATION_N_REPEATS = 5


def _permutation_importance_on_fold(
    clf: Any,
    X_test: pd.DataFrame,
    y_test: np.ndarray,
) -> np.ndarray | None:
    """Mean drop in score when feature is shuffled (n_repeats=5, random_state=42)."""
    if len(y_test) < 2 or len(np.unique(y_test)) < 2:
        return None
    for scoring in ("roc_auc", "accuracy"):
        try:
            res = permutation_importance(
                clf,
                X_test,
                y_test,
                n_repeats=PERMUTATION_N_REPEATS,
                random_state=PERMUTATION_RANDOM_STATE,
                scoring=scoring,
                n_jobs=-1,
            )
            return np.asarray(res.importances_mean, dtype=float)
        except ValueError:
            continue
    return None


def print_permutation_importance_table(
    feature_names: list[str],
    importances_mean: np.ndarray,
    *,
    top_n: int = 15,
    title_suffix: str = "",
) -> list[dict[str, Any]]:
    """
    Sorted table: Feature Name | Importance Weight (permutation mean Δ score).
    Weights are raw importances_mean (higher = more important for the chosen metric).
    """
    if len(importances_mean) != len(feature_names):
        print("\n( Permutation importance length mismatch; skipping table. )")
        return []

    order = np.argsort(importances_mean)[::-1][:top_n]
    total = float(np.sum(np.maximum(importances_mean, 0.0)))
    if total <= 0:
        total = 1.0

    w = 80
    print(f"\n{'=' * w}")
    print(
        f"Permutation importance — Top {top_n} features{title_suffix}\n"
        f"(sklearn.inspection.permutation_importance, n_repeats={PERMUTATION_N_REPEATS}, "
        f"random_state={PERMUTATION_RANDOM_STATE})"
    )
    print(f"{'=' * w}")
    print(f"{'Rank':<6}{'Feature Name':<36}{'Importance weight':>20}{'Share %':>12}")
    print("-" * w)
    rows: list[dict[str, Any]] = []
    for rank, j in enumerate(order, start=1):
        name = feature_names[j]
        wt = float(importances_mean[j])
        share = 100.0 * max(wt, 0.0) / total
        print(f"{rank:<6}{name:<36}{wt:>20.6f}{share:>11.2f}%")
        rows.append(
            {
                "rank": rank,
                "feature": name,
                "importance_weight": round(wt, 8),
                "share_pct": round(share, 4),
            }
        )
    print(f"{'=' * w}\n")
    return rows


def main() -> None:
    p = argparse.ArgumentParser(
        description=(
            "Train rating model: ATR-adjusted target + swing (BB width, 20d high) + MACD/volume + TimeSeriesSplit."
        )
    )
    p.add_argument("--tickers", type=str, default=",".join(DEFAULT_TICKERS))
    p.add_argument("--period", type=str, default="5y", help="yfinance history window.")
    p.add_argument(
        "--classifier",
        choices=("hgb", "xgb"),
        default="hgb",
        help="HistGradientBoostingClassifier (default) or XGBClassifier.",
    )
    p.add_argument("--n-splits", type=int, default=5, help="TimeSeriesSplit folds.")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument(
        "--calibrate",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Wrap final base estimator in sigmoid CalibratedClassifierCV(cv=3).",
    )
    p.add_argument("--out", type=Path, default=Path("models/rating_model.joblib"))
    args = p.parse_args()
    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]

    print(
        f"Building panel — target: close.shift(-{FORWARD_DAYS}) > close + "
        f"{ATR_TARGET_MULTIPLIER} * ATR_{ATR_WINDOW}"
    )
    panel = _stack_panel(tickers, period=args.period)
    if len(panel) == 0:
        raise SystemExit(
            "No training rows after dropna (features/target NaN). "
            "Try --period max or check network/yfinance data."
        )
    X = panel[FEATURE_COLUMNS].astype(np.float64)
    y = panel["y"].astype(int).values
    print(f"Rows after strict dropna: {len(panel)}, P(y=1)={y.mean():.4f}")

    tscv = TimeSeriesSplit(n_splits=args.n_splits)
    oof_proba = np.full(len(panel), np.nan, dtype=float)
    fold_aucs: list[float] = []
    perm_sum = np.zeros(len(FEATURE_COLUMNS), dtype=float)
    perm_fold_count = 0

    print(f"\nTimeSeriesSplit (n_splits={args.n_splits}) — out-of-fold AUC:")
    for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
        clf = _make_classifier(args.classifier, args.seed + fold)
        sw_tr = compute_sample_weight("balanced", y[train_idx])
        clf.fit(X.iloc[train_idx], y[train_idx], sample_weight=sw_tr)
        X_te = X.iloc[test_idx]
        y_te = y[test_idx]
        proba = clf.predict_proba(X_te)[:, 1]
        oof_proba[test_idx] = proba
        try:
            auc = roc_auc_score(y_te, proba)
            fold_aucs.append(float(auc))
            print(
                f"  Fold {fold + 1}: ROC-AUC = {auc:.4f}  "
                f"(train n={len(train_idx)}, test n={len(test_idx)})"
            )
        except ValueError as e:
            print(f"  Fold {fold + 1}: ROC-AUC skipped ({e})")

        pi_mean = _permutation_importance_on_fold(clf, X_te, y_te)
        if pi_mean is not None:
            perm_sum += pi_mean
            perm_fold_count += 1
            print(
                f"  Fold {fold + 1}: permutation importance OK "
                f"(test n={len(test_idx)}, n_repeats={PERMUTATION_N_REPEATS})"
            )
        else:
            print(f"  Fold {fold + 1}: permutation importance skipped (test set too small or one class)")

    if fold_aucs:
        print(f"Mean fold ROC-AUC: {float(np.mean(fold_aucs)):.4f}")

    if perm_fold_count > 0:
        perm_mean_agg = perm_sum / perm_fold_count
        perm_table_rows = print_permutation_importance_table(
            list(FEATURE_COLUMNS),
            perm_mean_agg,
            top_n=15,
            title_suffix=f" — mean over {perm_fold_count} CV fold(s), test-set permutation",
        )
    else:
        perm_mean_agg = np.zeros(len(FEATURE_COLUMNS))
        perm_table_rows = []
        print("\n(No permutation importance: no valid fold-level test sets.)\n")

    valid_oof = np.isfinite(oof_proba)
    y_oof = y[valid_oof]
    p_oof = oof_proba[valid_oof]
    print("\nOOF ROC-AUC (all labeled OOF rows):")
    try:
        print(f"  {roc_auc_score(y_oof, p_oof):.4f}")
    except ValueError as e:
        print(f"  skipped ({e})")

    y_hat_oof = (p_oof >= 0.5).astype(int)
    print("\nOOF classification report (threshold=0.5 on OOF probabilities):")
    print(classification_report(y_oof, y_hat_oof, digits=4, zero_division=0))

    print("\nTuning probability floor for PRECISION (min recall 0.20) on OOF predictions...")
    tune_cfg = tune_probability_threshold(
        y_oof,
        p_oof,
        mode="precision",
        min_recall=0.20,
        min_precision=0.0,
        min_predicted_positive=40,
    )
    print(f"  Chosen floor: {tune_cfg['probability_floor']:.4f}")
    print(
        f"  At floor — precision={tune_cfg['metrics_at_floor']['precision']:.4f}, "
        f"recall={tune_cfg['metrics_at_floor']['recall']:.4f}, "
        f"f1={tune_cfg['metrics_at_floor']['f1']:.4f}"
    )

    print("\nFitting final model on full chronological panel...")
    base_final = _make_classifier_final(args.classifier, args.seed)
    if args.calibrate:
        final_model: Any = CalibratedClassifierCV(base_final, method="sigmoid", cv=3)
        print("  (CalibratedClassifierCV cv=3 — may take several minutes)")
    else:
        final_model = base_final
    sw_full = compute_sample_weight("balanced", y)
    final_model.fit(X, y, sample_weight=sw_full)

    trained_at = datetime.now(timezone.utc).isoformat()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    artifact = {
        "model": final_model,
        "feature_columns": list(FEATURE_COLUMNS),
        "meta": {
            "feature_pipeline": FEATURE_PIPELINE_ID,
            "trained_at": trained_at,
            "tickers": tickers,
            "period": args.period,
            "classifier": args.classifier,
            "calibrated": bool(args.calibrate),
            "target": {
                "forward_sessions": FORWARD_DAYS,
                "atr_window": ATR_WINDOW,
                "atr_multiplier": ATR_TARGET_MULTIPLIER,
                "definition": (
                    f"close.shift(-{FORWARD_DAYS}) > close + {ATR_TARGET_MULTIPLIER} * ATR_{ATR_WINDOW}"
                ),
            },
            "features": {
                "library": "ta",
                "columns": list(FEATURE_COLUMNS),
                "notes": (
                    "macd_hist_diff_3: 3d change in MACD histogram; "
                    "relative_volume_20d: Volume / 20d mean volume; "
                    "bb_width: (Upper_BB - Lower_BB) / SMA20 (20d, 2*StdDev bands); "
                    "dist_from_20d_high: (Close - rolling 20d max Close) / rolling 20d max Close."
                ),
            },
            "evaluation": {
                "cv": "TimeSeriesSplit",
                "n_splits": args.n_splits,
                "fold_roc_aucs": fold_aucs,
                "mean_fold_roc_auc": float(np.mean(fold_aucs)) if fold_aucs else None,
                "oof_classification_report_0.5": classification_report(
                    y_oof, y_hat_oof, digits=4, zero_division=0, output_dict=True
                ),
                "oof_roc_auc": float(roc_auc_score(y_oof, p_oof))
                if len(np.unique(y_oof)) > 1
                else None,
                "permutation_importance": {
                    "method": "permutation_importance",
                    "n_repeats": PERMUTATION_N_REPEATS,
                    "random_state": PERMUTATION_RANDOM_STATE,
                    "scoring_try_order": ["roc_auc", "accuracy"],
                    "aggregated_over_folds": perm_fold_count,
                    "importances_mean_averaged": {
                        name: float(perm_mean_agg[i])
                        for i, name in enumerate(FEATURE_COLUMNS)
                    },
                },
            },
            "inference": {
                "probability_floor": tune_cfg["probability_floor"],
                "tune_for": "precision",
                "tune_min_recall": 0.20,
                "score_transform": "excess_over_floor",
                "metrics_at_floor": tune_cfg["metrics_at_floor"],
            },
            "permutation_importance_top15": perm_table_rows,
        },
    }
    joblib.dump(artifact, args.out)
    print(f"Wrote {args.out.resolve()}")


if __name__ == "__main__":
    main()
