# Repository layout

This document is the **map of the codebase**. Trading rules and env knobs stay in code (especially `main.py` and `.env.example`); this file only explains **where things live** and **how pieces connect**.

## Entry points

| What you run | File | Purpose |
|--------------|------|---------|
| Daily Alpaca loop (watchlist → ML → orders → `portfolio_stats.csv`) | `main.py` | Broker runner; adds `scripts/` to `sys.path` so `import scanner` resolves to `scripts/scanner.py`. |
| Flask rating API + HTML helpers | `wsgi.py` → `rating_engine/app.py` | HTTP API, history tables, loads `rating_engine/ai_rating` model. |
| Train / refresh the joblib classifier | `scripts/train_rating_model.py` | Writes `models/rating_model.joblib` (path overridden by `RATING_MODEL_PATH`). |
| Print Finviz tickers to stdout | `scripts/scanner.py` | Same screener filters `main.py` uses (`get_finviz_watchlist`). |

## Directory tree (logical)

```
algo-trading-bot/
├── main.py                 # Alpaca runner (Finviz → ML → entries / exits → CSV stats)
├── wsgi.py                 # Flask app factory entry (`flask run`, Docker CMD)
├── docker-compose.yml      # rating-engine (Flask) + dashboard (Node)
├── Dockerfile              # Python image for rating-engine service
├── requirements.txt        # Python deps
├── .env / .env.example     # Secrets and tuning (both runners read `.env`)
├── models/                 # `rating_model.joblib` (+ training outputs)
├── portfolio_stats.csv     # Appended by `main.py` (benchmark vs SPY)
├── rating_engine/          # ML + Flask API package
│   ├── app.py              # Flask routes, HTML, JSON
│   ├── ai_rating.py        # Load artifact, `rating_for_ticker`, score → label
│   ├── training_features.py # TA + regime features for TA pipeline model
│   ├── features.py         # Legacy OHLCV feature columns (older pipeline)
│   ├── market_data.py      # `fetch_daily_history` (yfinance)
│   ├── threshold_tuning.py # Probability cutoff search (training)
│   ├── config.py           # `WATCHLIST_TICKERS` for Flask/demo (not `main.py` watchlist)
│   └── rating.py           # Re-export `rating_for_ticker` for a stable import path
├── scripts/
│   ├── scanner.py          # Finviz overview screener → symbol list
│   └── train_rating_model.py
├── tests/                  # `unittest` modules (no network by default)
└── dashboard/              # Node Express UI (reads CSV + optional Alpaca)
    ├── server.js
    └── Dockerfile
```

## Data flow (mental model)

1. **Scanner** (`scripts/scanner.py`): Finviz “Top Gainers” + liquidity / cap filters → list of tickers.
2. **Rating** (`rating_engine/ai_rating.py`): For each ticker, yfinance OHLCV → features → sklearn model → `score` (0–100) + `rating` string.
3. **Runner** (`main.py`): Compares rating to `ENTRY_MIN_RATING`, size with `POSITION_PCT_EQUITY`, sends Alpaca orders, places protective exits (trailing vs fixed stop per Alpaca rules), appends stats.
4. **API** (`rating_engine/app.py`): Same model for HTTP/HTML; watchlist for demos comes from `config.get_watchlist_tickers()` (env `WATCHLIST_TICKERS`), **not** the Finviz screener.
5. **Dashboard** (`dashboard/server.js`): Serves `public/index.html`. JSON routes return **public-only** fields (no absolute paths, broker raw errors, or internal URLs); `/api/stats` exposes `source_file` basename only; `/api/model` and `/api/ratings` are filtered or generic on failure.

## Configuration

- **`.env.example`**: Documented variables (copy to `.env`).
- **`main.py`** and **`dashboard/server.js`** both load the repo **`.env`** (not `.env.example`).

## Further reading

- **`Trading_Bot_Project_Plan.md`**: Original product narrative (may mention behavior that drifted; trust code + this file for layout).
