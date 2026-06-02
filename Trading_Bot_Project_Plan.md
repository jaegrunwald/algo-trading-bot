# Quantitative Portfolio Management & Algorithmic Trading System

**Repo map and entry points:** [ARCHITECTURE.md](./ARCHITECTURE.md)

## 1. Project Overview
A fully automated, machine learning-driven portfolio management system designed to actively trade a simulated $100,000 Alpaca brokerage account. The objective is to consistently outperform the S&P 500 (SPY) benchmark. The system utilizes a dynamic pre-market scanner to find high-liquidity stocks in play, applies a precision-tuned classification model to detect volatility squeezes and momentum, and executes trades autonomously with strict position sizing and automated risk management.

---

## 2. System Architecture & Tech Stack

The platform is organized into two layers: a **Python trading core** (scanner, ML engine, execution bot) and a **Next.js web platform** (dashboard, API, database). These communicate over internal Fly.io networking in production and localhost in development.

### 2.1 Python Trading Core (unchanged)

| Service | Technology | Role |
|---------|-----------|------|
| Scanner | Python, `finvizfinance` | Scrapes market, generates daily watchlist of top 50 mid/large-cap equities |
| Rating Engine | Python, Pandas, scikit-learn, Flask | Ingests OHLCV data, calculates micro-structure features, returns calibrated ML probability scores |
| Execution Bot | Python, Alpaca Trade API (`main.py`) | Orchestrates daily loop: scan → rate → size → trade → log |

### 2.2 Web Platform (migrating to Next.js)

| Layer | Technology | Replaces |
|-------|-----------|---------|
| Frontend | **Next.js 15 (App Router) + React** | Vanilla JS / HTML |
| API | **tRPC** | Express routes (`/api/*`) |
| Database | **Prisma + PostgreSQL (Fly Postgres)** | `portfolio_stats.csv`, `.scheduler-config.json`, `.pending_orders.json` |
| Auth | **NextAuth.js** | None (currently open) |
| Charts | **Recharts** or Chart.js | Chart.js CDN |

### 2.3 Infrastructure

| Concern | Solution |
|---------|---------|
| Hosting | Fly.io — single unified app (Next.js + Python services co-located) |
| Python bridge | Next.js API routes proxy to Flask rating engine over `.internal` |
| Bot control | Next.js server spawns `main.py` as child process (same as current scheduler) |
| Secrets | Fly secrets (Alpaca keys, DB URL, NextAuth secret) |
| Local dev | `npm run dev` (Next.js) + `flask run` (rating engine) + `python main.py --dry-run` |

---

## 3. Migration Plan (Vanilla → Next.js)

### Phase A — Scaffold & parity (current priority)
- Initialize Next.js 15 app with App Router inside `/dashboard`
- Set up tRPC with procedures mirroring current Express endpoints:
  - `positions.list`, `stats.list`, `stats.append`
  - `scheduler.get`, `scheduler.setConfig`, `scheduler.runNow`, `scheduler.stop`, `scheduler.stream`
  - `ratings.list`, `model.get`, `engine.health`
- Set up Prisma schema for `PortfolioStat`, `SchedulerConfig`, `BotLogEntry`
- Provision Fly Postgres and run initial migration
- Re-implement all current dashboard pages as React components with feature parity

### Phase B — Enhanced dashboard
- Real-time bot log stream via tRPC subscription (replaces SSE)
- Scheduler page with full settings UI (interval, hours window, dry-run)
- Home overview page: live KPIs, positions preview, mini chart, bot activity log
- Authentication via NextAuth (protect the dashboard behind login)

### Phase C — Full Fly consolidation
- Merge `algo-trading-bot` and `algo-trading-rating` into a single Fly app
- Single `Dockerfile` with Node 20 + Python 3.12, both services co-located
- Persistent Fly volume for model artifacts and any remaining file state
- Remove the separate `algo-trading-rating` Fly app

---

## 4. Database Schema (Prisma)

```prisma
model PortfolioStat {
  id              Int      @id @default(autoincrement())
  timestampUtc    DateTime
  portfolioValue  Float
  spyEquivalent   Float
  createdAt       DateTime @default(now())
}

model SchedulerConfig {
  id               Int     @id @default(1)
  enabled          Boolean @default(false)
  intervalMinutes  Int     @default(60)
  hoursStart       Int     @default(9)
  hoursEnd         Int     @default(16)
  dryRun           Boolean @default(false)
  watchlistLimit   Int     @default(50)
  updatedAt        DateTime @updatedAt
}

model BotLogEntry {
  id        Int      @id @default(autoincrement())
  tag       String
  message   String
  createdAt DateTime @default(now())
}
```

---

## 5. Original Development Roadmap (completed phases)

### Phase 1: Infrastructure & Dynamic Scanning ✓
- Initialized Git, virtual environments, and baseline API structures
- Developed `scripts/scanner.py` using Finviz to filter 8,000+ US equities down to a top 50 daily watchlist

### Phase 2: ML Engine ✓
- **Target Variable:** Forward 5-day close > current close + 1.0 × 14-day ATR
- **Features:** MACD histogram diff, relative volume, Bollinger Band Width, distance from 20-day high
- **Training:** `TimeSeriesSplit` to prevent look-ahead bias; threshold tuned for precision; validated with Permutation Importance

### Phase 3: Portfolio Execution ✓
- `main.py` as autonomous orchestrator
- 5% equity position sizing, max 20 concurrent positions
- Trailing stop-losses via Alpaca API
- Daily SPY benchmark logging

### Phase 4: Dashboard (v1 — vanilla JS) ✓
- Node.js/Express + Chart.js
- Portfolio growth vs SPY, positions P/L, model metadata, ML watchlist ratings
- Scheduler with live SSE log stream, auto-run toggle, trading hours window

### Phase 5: Dashboard (v2 — Next.js migration) ← current
- Migrate to Next.js + tRPC + Prisma + NextAuth
- Full Fly.io consolidation into a single unified deployment

---

## 6. Portfolio & Career Alignment

This architecture targets multiple high-tier engineering disciplines:

- **Quantitative Data Science:** Time-series discipline (look-ahead bias, multicollinearity), precision-optimized ML, Permutation Importance for signal extraction from noisy financial data
- **Platform & Financial Engineering:** Automated execution pipelines, Alpaca API integration, capital protection algorithms (position sizing + trailing stops)
- **Full-Stack Engineering:** Modern React/Next.js, type-safe tRPC APIs, Prisma ORM, PostgreSQL, cloud deployment on Fly.io
- **DevOps:** Multi-service Docker builds, Fly.io secrets management, persistent volumes, internal networking between services
