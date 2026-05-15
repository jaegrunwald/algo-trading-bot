/**
 * Dashboard: portfolio vs SPY (CSV), model meta from rating-engine, optional Alpaca P/L.
 * Repo map: ../ARCHITECTURE.md
 */
import dotenv from "dotenv";
import dns from "node:dns";
import express from "express";
import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Same file as main.py — never `.env.example` (that file is documentation only). */
const REPO_DOTENV_PATH = path.resolve(__dirname, "..", ".env");
dotenv.config({ path: REPO_DOTENV_PATH, override: true });

// Fly `.internal` is often IPv6-first; Node's default dns reorder can break outbound fetch from the dashboard.
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("verbatim");
}

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
app.use(express.json({ limit: "32kb" }));
/** Flask uses `PORT` in .env (e.g. 5001). Dashboard must not steal it — use DASHBOARD_PORT only. */
const PORT = dashboardListenPort();
const defaultStats = path.join(__dirname, "..", "portfolio_stats.csv");
const STATS_PATH = process.env.PORTFOLIO_STATS_PATH || defaultStats;
/** Baked into Fly image at build time; used to seed a writable volume copy. */
const STATS_SEED_PATH = process.env.PORTFOLIO_STATS_SEED_PATH || "/portfolio_stats.csv";

/** On Fly, defaulting to localhost never reaches a separate rating app — require the secret. */
function ratingEngineBaseUrl() {
  const raw = (process.env.RATING_ENGINE_URL || "").trim().replace(/\/$/, "");
  if (raw) return raw;
  if (process.env.FLY_APP_NAME) {
    console.warn(
      "RATING_ENGINE_URL is unset. Set: fly secrets set RATING_ENGINE_URL=http://<rating-app>.internal:5000 -a this-app"
    );
    return "";
  }
  return "http://127.0.0.1:5001";
}

const RATING_ENGINE_URL = ratingEngineBaseUrl();

function logRatingFetchFailure(label, url, err) {
  let host = "?";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  console.warn(`[rating] ${label} host=${host} err=${msg}`);
}

if (!existsSync(STATS_PATH)) {
  console.warn(`STATS_PATH not found (${STATS_PATH}); /api/stats will be empty until file exists or PORTFOLIO_STATS_PATH is set.`);
}

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

async function seedStatsFileIfNeeded() {
  if (existsSync(STATS_PATH)) return;
  if (!existsSync(STATS_SEED_PATH) || STATS_SEED_PATH === STATS_PATH) return;
  try {
    await fs.mkdir(path.dirname(STATS_PATH), { recursive: true });
    await fs.copyFile(STATS_SEED_PATH, STATS_PATH);
    console.log(`Seeded stats from ${STATS_SEED_PATH} → ${STATS_PATH}`);
  } catch (e) {
    console.warn(`Could not seed stats file: ${e.message || e}`);
  }
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

function noStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
}

app.get("/api/stats", async (_req, res) => {
  noStore(res);
  try {
    const raw = await fs.readFile(STATS_PATH, "utf8");
    const rows = parseStatsCsv(raw);
    let updated_at = null;
    try {
      const st = await fs.stat(STATS_PATH);
      updated_at = st.mtime.toISOString();
    } catch {
      /* ignore */
    }
    res.json({ row_count: rows.length, rows, source_file: statsSourceLabel(), updated_at });
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

/** Append one run row (for local `main.py` → Fly dashboard). Requires DASHBOARD_STATS_TOKEN on the server. */
app.post("/api/stats/append", async (req, res) => {
  noStore(res);
  const expected = (process.env.DASHBOARD_STATS_TOKEN || "").trim();
  if (!expected) {
    return res.status(503).json({
      error: "stats_push_disabled",
      message: "Set DASHBOARD_STATS_TOKEN on the dashboard server.",
    });
  }
  const got = String(req.headers["x-stats-token"] || "").trim();
  if (got !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const ts = String(body.timestamp_utc || "").trim();
  const pv = Number(body.total_portfolio_value);
  const spy = Number(body.spy_equivalent_value);
  if (!ts || !Number.isFinite(pv) || !Number.isFinite(spy)) {
    return res.status(400).json({
      error: "invalid_body",
      message: "Need timestamp_utc, total_portfolio_value, spy_equivalent_value.",
    });
  }
  try {
    await seedStatsFileIfNeeded();
    const newFile = !existsSync(STATS_PATH);
    const line = `${ts},${pv.toFixed(2)},${spy.toFixed(2)}\n`;
    if (newFile) {
      await fs.writeFile(
        STATS_PATH,
        "timestamp_utc,total_portfolio_value,spy_equivalent_value\n" + line,
        "utf8"
      );
    } else {
      await fs.appendFile(STATS_PATH, line, "utf8");
    }
    const rows = parseStatsCsv(await fs.readFile(STATS_PATH, "utf8"));
    return res.json({ ok: true, row_count: rows.length, source_file: statsSourceLabel() });
  } catch (e) {
    console.warn("[stats] append failed:", e.message || e);
    return res.status(500).json({ error: "stats_append_failed" });
  }
});

app.get("/api/model", async (_req, res) => {
  if (!RATING_ENGINE_URL) {
    return res.status(503).json({
      error: "rating_engine_not_configured",
      message: "Set Fly secret RATING_ENGINE_URL=http://<rating-app>.internal:5000",
    });
  }
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
    logRatingFetchFailure("model", url, e);
    return res.status(503).json({
      error: "rating_engine_unreachable",
      message: "Model service unavailable.",
    });
  }
});

/** Lightweight reachability check for the dashboard header. */
app.get("/api/engine-health", async (_req, res) => {
  if (!RATING_ENGINE_URL) {
    return res.status(503).json({
      error: "rating_engine_not_configured",
      message: "Set Fly secret RATING_ENGINE_URL=http://<rating-app>.internal:5000",
    });
  }
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
    logRatingFetchFailure("health", url, e);
    return res.status(503).json({
      error: "rating_engine_unreachable",
      message: "Model service unavailable.",
    });
  }
});

/** Parse-only: verify Fly secret shape (no secrets leaked). */
app.get("/api/rating-debug", (_req, res) => {
  const raw = (process.env.RATING_ENGINE_URL || "").trim();
  if (!raw) {
    return res.json({
      env_RATING_ENGINE_URL: false,
      resolved_base: RATING_ENGINE_URL || null,
      on_fly: Boolean(process.env.FLY_APP_NAME),
    });
  }
  try {
    const u = new URL(raw.replace(/\/$/, ""));
    return res.json({
      env_RATING_ENGINE_URL: true,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? "443" : "80"),
      hint:
        "Prefer http://<rating-app>.internal:5000 on Fly. If you still get rating_engine_unreachable, try https://<rating-app>.fly.dev (public edge; dashboard still calls it server-side).",
    });
  } catch {
    return res.json({ env_RATING_ENGINE_URL: true, parse_error: true });
  }
});

/** Proxy watchlist ML ratings (can be slow — many tickers × yfinance). */
app.get("/api/ratings", async (req, res) => {
  if (!RATING_ENGINE_URL) {
    return res.status(503).json({
      error: "rating_engine_not_configured",
      message: "Set Fly secret RATING_ENGINE_URL=http://<rating-app>.internal:5000",
    });
  }
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
    logRatingFetchFailure("ratings", url, e);
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

const publicDir = path.join(__dirname, "public");

app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/benchmark", (_req, res) => res.sendFile(path.join(publicDir, "benchmark.html")));
app.get("/watchlist", (_req, res) => res.sendFile(path.join(publicDir, "watchlist.html")));
app.get("/model", (_req, res) => res.sendFile(path.join(publicDir, "model.html")));
app.get("/positions", (_req, res) => res.sendFile(path.join(publicDir, "positions.html")));

app.use(express.static(publicDir));

await seedStatsFileIfNeeded();

app.listen(PORT, dashboardListenHost(), () => {
  const { key, secret } = alpacaCredentials();
  const host = dashboardListenHost();
  console.log(`Dashboard listening on ${host}:${PORT}`);
  console.log(`  Stats file: ${STATS_PATH}`);
  if ((process.env.DASHBOARD_STATS_TOKEN || "").trim()) {
    console.log("  Stats push: POST /api/stats/append (X-Stats-Token)");
  }
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
