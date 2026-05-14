/**
 * Dashboard: portfolio vs SPY (CSV), model meta from rating-engine, optional Alpaca P/L.
 * Repo map: ../ARCHITECTURE.md
 */
import dotenv from "dotenv";
import express from "express";
import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Same file as main.py — never `.env.example` (that file is documentation only). */
const REPO_DOTENV_PATH = path.resolve(__dirname, "..", ".env");
dotenv.config({ path: REPO_DOTENV_PATH, override: true });

function dashboardListenPort() {
  const raw = (process.env.DASHBOARD_PORT || "").trim();
  const n = raw ? parseInt(raw, 10) : 3000;
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    console.warn(`Invalid DASHBOARD_PORT=${JSON.stringify(process.env.DASHBOARD_PORT)}; using 3000.`);
    return 3000;
  }
  return n;
}

/** Use 0.0.0.0 in Docker so port publishing works; override with DASHBOARD_LISTEN_HOST=127.0.0.1 if needed. */
function dashboardListenHost() {
  const h = (process.env.DASHBOARD_LISTEN_HOST || "0.0.0.0").trim();
  return h || "0.0.0.0";
}

const app = express();
/** Flask uses `PORT` in .env (e.g. 5001). Dashboard must not steal it — use DASHBOARD_PORT only. */
const PORT = dashboardListenPort();
const defaultStats = path.join(__dirname, "..", "portfolio_stats.csv");
const STATS_PATH = process.env.PORTFOLIO_STATS_PATH || defaultStats;
const RATING_ENGINE_URL = (process.env.RATING_ENGINE_URL || "http://127.0.0.1:5001").replace(
  /\/$/,
  ""
);

/** Match main.py: APCA_* preferred, ALPACA_* accepted. */
function alpacaCredentials() {
  const key = (
    process.env.APCA_API_KEY_ID ||
    process.env.ALPACA_API_KEY_ID ||
    ""
  ).trim();
  const secret = (
    process.env.APCA_API_SECRET_KEY ||
    process.env.ALPACA_API_SECRET_KEY ||
    ""
  ).trim();
  return { key, secret };
}

function parseStatsCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",");
    if (row.length < 3) continue;
    const [timestamp_utc, total_portfolio_value, spy_equivalent_value] = row;
    const pv = parseFloat(total_portfolio_value);
    const spy = parseFloat(spy_equivalent_value);
    if (!Number.isFinite(pv) || !Number.isFinite(spy)) continue;
    out.push({ timestamp_utc, total_portfolio_value: pv, spy_equivalent_value: spy });
  }
  return out;
}

/** Safe for public HTML: no absolute paths, hostnames, or stack traces. */
function statsSourceLabel() {
  return path.basename(STATS_PATH) || "portfolio_stats.csv";
}

function truncatePublic(s, max = 180) {
  const t = String(s || "");
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Drop large / sensitive fields from rating-engine model JSON before sending to the browser. */
function publicModelPayload(body) {
  if (!body || typeof body !== "object") return {};
  const allow = [
    "trained_at",
    "feature_pipeline",
    "classifier",
    "period",
    "inference",
  ];
  const out = {};
  for (const k of allow) {
    if (body[k] === undefined) continue;
    out[k] = body[k];
  }
  if (body.error != null && typeof body.error === "string") {
    out.error = truncatePublic(body.error, 160);
  }
  return out;
}

/** Only what the table needs; no full watchlist echo; trim long ML errors. */
function publicRatingsPayload(body) {
  if (!body || typeof body !== "object") return {};
  const data = Array.isArray(body.data) ? body.data : [];
  const errors = Array.isArray(body.errors)
    ? body.errors.map((e) => ({
        ticker: e.ticker,
        error: truncatePublic(e.error),
      }))
    : [];
  return {
    period: body.period,
    summary: body.summary,
    data,
    errors,
  };
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/stats", async (_req, res) => {
  try {
    const raw = await fs.readFile(STATS_PATH, "utf8");
    const rows = parseStatsCsv(raw);
    res.json({ row_count: rows.length, rows, source_file: statsSourceLabel() });
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return res.json({
        row_count: 0,
        rows: [],
        note: "stats_file_missing",
        source_file: statsSourceLabel(),
      });
    }
    res.status(500).json({ error: "stats_unavailable" });
  }
});

app.get("/api/model", async (_req, res) => {
  const url = `${RATING_ENGINE_URL}/api/model`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    clearTimeout(t);
    if (!r.ok) {
      return res.status(502).json({
        error: "model_unavailable",
        message: "Could not load model metadata.",
      });
    }
    return res.json(publicModelPayload(body));
  } catch (e) {
    clearTimeout(t);
    return res.status(503).json({
      error: "rating_engine_unreachable",
      message: "Model service unavailable.",
    });
  }
});

/** Lightweight reachability check for the dashboard header. */
app.get("/api/engine-health", async (_req, res) => {
  const url = `${RATING_ENGINE_URL}/health`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    clearTimeout(t);
    if (r.ok && body.status === "ok") {
      return res.json({ status: "ok" });
    }
    return res.json({ status: "down" });
  } catch (e) {
    clearTimeout(t);
    return res.status(503).json({
      error: "rating_engine_unreachable",
      message: "Model service unavailable.",
    });
  }
});

/** Proxy watchlist ML ratings (can be slow — many tickers × yfinance). */
app.get("/api/ratings", async (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const url = `${RATING_ENGINE_URL}/api/ratings${qs}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    clearTimeout(t);
    if (!r.ok) {
      return res.status(502).json({
        error: "ratings_unavailable",
        message: "Could not load watchlist ratings.",
      });
    }
    return res.json(publicRatingsPayload(body));
  } catch (e) {
    clearTimeout(t);
    return res.status(503).json({
      error: "rating_engine_unreachable",
      message: "Ratings service unavailable.",
    });
  }
});

app.get("/api/positions", async (_req, res) => {
  const { key, secret } = alpacaCredentials();
  if (!key || !secret) {
    return res.json({
      enabled: false,
      positions: [],
      note: "Broker positions are not configured on this server.",
    });
  }
  const paper = !["false", "0"].includes(String(process.env.ALPACA_PAPER ?? "true").toLowerCase());
  const base = paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${base}/v2/positions`, {
      signal: ctrl.signal,
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
      },
    });
    clearTimeout(t);
    if (!r.ok) {
      await r.text().catch(() => {});
      return res.status(502).json({
        enabled: true,
        paper,
        error: "Could not load positions from the broker.",
        positions: [],
      });
    }
    const raw = await r.json();
    const positions = (Array.isArray(raw) ? raw : []).map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      market_value: p.market_value,
      cost_basis: p.cost_basis,
      unrealized_pl: p.unrealized_pl,
      unrealized_plpc: p.unrealized_plpc,
      avg_entry_price: p.avg_entry_price,
      current_price: p.current_price,
    }));
    return res.json({ enabled: true, paper, positions });
  } catch (e) {
    clearTimeout(t);
    return res.status(503).json({
      enabled: true,
      error: "Could not reach the broker.",
      positions: [],
    });
  }
});

app.listen(PORT, dashboardListenHost(), () => {
  const { key, secret } = alpacaCredentials();
  const host = dashboardListenHost();
  console.log(`Dashboard listening on ${host}:${PORT}`);
  console.log(`  → http://localhost:${PORT}/`);
  console.log(`  → http://127.0.0.1:${PORT}/`);
  console.log(
    "  (If an in-IDE browser shows ERR_ADDRESS_INVALID, open one of the links above in Safari or Chrome.)"
  );
  console.log(
    `Env: ${REPO_DOTENV_PATH} (${existsSync(REPO_DOTENV_PATH) ? "file exists" : "file missing"}) · Alpaca keys: ${
      key && secret ? "loaded" : "absent"
    } · Rating engine proxy: ${RATING_ENGINE_URL}`
  );
});
