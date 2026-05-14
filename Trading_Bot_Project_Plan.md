# Quantitative Portfolio Management & Algorithmic Trading System

**Repo map and entry points:** [ARCHITECTURE.md](./ARCHITECTURE.md)

## 1. Project Overview
A fully automated, machine learning-driven portfolio management system designed to actively trade a simulated $100,000 Alpaca brokerage account [cite: 1]. The objective is to consistently outperform the S&P 500 (SPY) benchmark [cite: 1]. The system utilizes a dynamic pre-market scanner to find high-liquidity stocks in play, applies a precision-tuned classification model to detect volatility squeezes and momentum, and executes trades autonomously with strict position sizing and automated risk management [cite: 1].

## 2. System Architecture & Tech Stack
The platform relies on independent, specialized services to ensure clean separation between daily scanning, offline model training, and active execution [cite: 1].

* **The Dynamic Scanner:** Python, `finvizfinance`. Scrapes the market to generate a daily watchlist of mid/large-cap equities experiencing unusual momentum, ensuring the ML model only evaluates highly liquid, "in-play" assets [cite: 1].
* **The Rating Engine (Data Science / ML):** Python, Pandas, `scikit-learn`. Ingests OHLCV data, calculates micro-structure features (Volume, Bollinger Bands, MACD), and loads a serialized `HistGradientBoostingClassifier` [cite: 1]. It returns a calibrated probability score that must cross a high "Precision Floor" to trigger a Buy signal [cite: 1].
* **The Portfolio Execution Service (Platform Engineering):** Python, Alpaca Trade API (`main.py`). A scheduled worker that orchestrates the daily loop: running the scanner, querying the Rating Engine, calculating 5% position sizes based on current account equity, deploying trailing stop-losses, and logging daily performance against the SPY benchmark [cite: 1].
* **The Dashboard (User Interface):** Node.js, Express. Portfolio view, P/L, and comparison against a "Buy & Hold SPY" equivalent [cite: 1].

## 3. Development Environment Setup
* **Docker:** Containerize the API and dashboard for seamless execution across macOS and Windows development environments [cite: 1].
* **Git/GitHub:** Strict version control tracking the feature specification pipeline and training scripts [cite: 1].
* **Virtual Environments (`venv`):** Isolated Python dependencies [cite: 1].
* **Model Artifacts:** The trained `rating_model.joblib` is treated as a release asset, complete with embedded metadata detailing its precision threshold and permutation importances [cite: 1].

## 4. Phased Development Roadmap

### Phase 1: Infrastructure & Dynamic Scanning
* Initialize Git, virtual environments, and baseline API structures [cite: 1].
* Develop `scripts/scanner.py` using Finviz to filter the 8,000+ US equity universe down to a top 50 daily watchlist based on Market Cap (> $2B), Average Volume (> 2M), and Top Gainer momentum [cite: 1].

### Phase 2: The Micro-Structure ML Engine (Swing Trading)
* **Target Variable:** Predict a Volatility-Adjusted return (Forward 5-day close > current close + 1.0 * 14-day ATR) [cite: 1].
* **Feature Engineering:** Build Pandas pipelines exclusively focused on micro-structure and momentum (ignoring macro-regime data to prevent multicollinearity) [cite: 1].
    * *Momentum:* MACD Histogram 3-day difference [cite: 1].
    * *Institutional Footprints:* Relative Volume (20-day average) [cite: 1].
    * *Volatility Squeeze:* Bollinger Band Width [cite: 1].
    * *Price Context:* Distance from 20-day High [cite: 1].
* **Training & Evaluation:** Use `TimeSeriesSplit` to prevent look-ahead bias [cite: 1]. Optimize the probability threshold strictly for **Precision** (avoiding false positives) [cite: 1]. Validate feature validity using Permutation Importance [cite: 1].

### Phase 3: Portfolio Management & Execution (Alpaca Integration)
* Develop `main.py` as the autonomous orchestrator [cite: 1].
* **Position Sizing:** Dynamically calculate trade sizes to equal exactly 5% of the total current portfolio equity (max 20 concurrent positions) [cite: 1].
* **Risk Management:** Implement automated Trailing Stop-Losses via the Alpaca API to cut losing trades quickly [cite: 1].
* **Benchmarking:** At the close of each run, log the portfolio's total equity alongside the `spy_equivalent_value` to track the generated Alpha [cite: 1].

### Phase 4: The Benchmarking Dashboard
* Develop a Node.js/Express frontend using Chart.js [cite: 1].
* Visualize the portfolio's growth curve overlaid directly against the S&P 500 benchmark [cite: 1].
* Display active holdings, their current P/L, and the model's metadata (last trained date, current precision floor) [cite: 1].

## 5. Portfolio & Career Alignment
This architecture is structured to simulate a professional quantitative environment, acting as a high-tier resume asset [cite: 1]:
* **Quantitative Data Science:** Showcases the ability to handle severe time-series challenges (look-ahead bias, multicollinearity), optimize models for precision over raw accuracy, and utilize Permutation Importance to extract actionable signals from noisy financial data [cite: 1].
* **Platform & Financial Engineering:** Demonstrates the ability to build robust, automated execution pipelines, integrate external brokerage APIs, and crucially, implement strict capital protection algorithms (position sizing and trailing stops) required by modern financial institutions [cite: 1].
