# Algorithmic Paper Trading Platform: Project Specification

## 1. Project Overview
A fully automated, microservice-based paper trading platform that tracks equity trends, calculates a weighted Buy/Hold/Sell rating, and executes trades autonomously against a simulated $100,000 portfolio using the Alpaca API.

## 2. System Architecture & Tech Stack
To ensure clean separation of concerns and robust performance, the system is structured around independent microservices. 

* **The Rating Engine (Data Science Focus):** Python, Flask, Pandas, NumPy. Responsible for ingesting market data, calculating indicators (Moving Averages, RSI), and outputting a definitive rating.
* **The Execution Service (Platform Engineering Focus):** Python, Alpaca Trade API. A scheduled worker process that queries the Rating Engine and submits orders to the Alpaca brokerage.
* **The Dashboard (User Interface):** Node.js, Express. Provides a real-time view of the Alpaca portfolio, active holdings, and daily profit/loss.

## 3. Development Environment Setup
To maintain consistency across both macOS and Windows workstations during development, the project should utilize:
* **Docker:** Containerize the Flask API and Node.js dashboard to eliminate cross-platform environment discrepancies.
* **Git/GitHub:** Strict version control for seamless syncing between machines.
* **Virtual Environments (`venv`):** For isolated Python dependencies.

## 4. Phased Development Roadmap

### Phase 1: Infrastructure & Data Pipelines
* Initialize the Git repository and define a `docker-compose.yml` file.
* Set up the Flask application skeleton.
* Integrate a market data API (e.g., `yfinance` or Alpha Vantage) to pull daily historical data for a target list of tickers.

### Phase 2: The Rating Algorithm
* Implement the core logic using Pandas to process time-series data.
* Develop a weighted scoring system:
    * **Moving Averages:** Trend confirmation.
    * **RSI:** Momentum and overbought/oversold detection.
* Expose an internal API endpoint: `GET /api/rating/<ticker>` returning `{"ticker": "AAPL", "rating": "Strong Buy", "score": 85}`.

### Phase 3: Alpaca Integration & Execution
* Generate Alpaca Paper Trading API keys.
* Write the execution script that iterates through a watchlist, requests ratings from the local Flask API, and fires `api.submit_order()` for "Strong Buy" signals.
* Implement basic risk management (e.g., ensuring no single asset exceeds 10% of total buying power).

### Phase 4: The Node.js Dashboard
* Set up an Express server to serve the frontend.
* Use the Alpaca API to fetch account data (`api.get_account()`) and current positions (`api.list_positions()`).
* Visualize portfolio growth and current holdings using a charting library like Chart.js.

## 5. Portfolio & Career Alignment
This architecture directly supports building a highly competitive resume for advanced technical roles:
* **Data Science:** Showcases time-series data manipulation, algorithm design, and quantitative analysis using Pandas.
* **Platform Engineering:** Demonstrates experience designing independent microservices, managing secure API integrations, scheduling automated tasks, and containerizing full-stack applications.
