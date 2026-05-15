"use strict";

const THEME_KEY = "trading-dashboard-theme";
const PAGE = document.body.getAttribute("data-page") || "home";

function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(n));
}
function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return (100 * Number(n)).toFixed(2) + "%";
}
function ratingClass(label) {
  const s = String(label || "").toLowerCase();
  if (s.includes("strong buy")) return "sb";
  if (s.includes("strong sell")) return "ss";
  if (s.includes("buy")) return "buy";
  if (s.includes("sell")) return "sell";
  if (s.includes("hold")) return "hold";
  return "";
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefers = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", saved || prefers);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
  if (window._benchChart) window._benchChart.destroy();
  window._benchChart = null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setPills({ healthOk, statsState, sourceFile, alpaca }) {
  const el = document.getElementById("statusPills");
  if (!el) return;
  const pills = [];
  const statsLabels = {
    ok: ["Stats OK", "ok"],
    missing: ["No portfolio_stats.csv", "warn"],
    empty: ["CSV empty (header only?)", "warn"],
  };
  const [sl, sc] = statsLabels[statsState] || statsLabels.empty;
  pills.push(`<span class="pill ${sc}">${sl}</span>`);
  pills.push(`<span class="pill ${healthOk ? "ok" : "err"}">Rating API ${healthOk ? "reachable" : "down"}</span>`);
  if (alpaca === "ok") pills.push(`<span class="pill ok">Alpaca OK</span>`);
  else if (alpaca === "err") pills.push(`<span class="pill err">Alpaca error</span>`);
  else pills.push(`<span class="pill warn">Alpaca not configured</span>`);
  if (sourceFile) pills.push(`<span class="pill">${escapeHtml(sourceFile)}</span>`);
  el.innerHTML = pills.join("");
}

function setActiveNav() {
  const path = window.location.pathname || "/";
  document.querySelectorAll("nav.site-nav a").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    if (href === path || (path === "/" && href === "/")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function renderKpis(rows) {
  const el = document.getElementById("kpiRow");
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="kpi"><span>Latest</span><strong>—</strong><small>No runs yet</small></div>';
    return;
  }
  const last = rows[rows.length - 1];
  const pv = last.total_portfolio_value;
  const spy = last.spy_equivalent_value;
  const delta = pv - spy;
  const deltaPct = spy > 0 ? (pv / spy - 1) * 100 : NaN;
  el.innerHTML = `
        <div class="kpi"><span>Portfolio (last)</span><strong>${fmtUsd(pv)}</strong><small>${escapeHtml(String(last.timestamp_utc).slice(0, 19))}Z</small></div>
        <div class="kpi"><span>SPY equivalent</span><strong>${fmtUsd(spy)}</strong><small>Buy &amp; hold benchmark</small></div>
        <div class="kpi"><span>Δ vs SPY ($)</span><strong style="color:${delta >= 0 ? "var(--pos)" : "var(--neg)"}">${fmtUsd(delta)}</strong><small>portfolio − benchmark</small></div>
        <div class="kpi"><span>Δ vs SPY (%)</span><strong style="color:${deltaPct >= 0 ? "var(--pos)" : "var(--neg)"}">${Number.isFinite(deltaPct) ? deltaPct.toFixed(2) + "%" : "—"}</strong><small>${rows.length} run(s) logged</small></div>`;
}

function renderStatsTable(rows) {
  const thead = document.querySelector("#statsTable thead");
  const tbody = document.querySelector("#statsTable tbody");
  if (!thead || !tbody) return;
  thead.innerHTML = "<tr><th>Timestamp (UTC)</th><th>Portfolio</th><th>SPY eq.</th><th>Δ $</th><th>Δ %</th></tr>";
  tbody.innerHTML = "";
  const rev = rows.slice().reverse().slice(0, 80);
  for (const r of rev) {
    const d = r.total_portfolio_value - r.spy_equivalent_value;
    const dp = r.spy_equivalent_value > 0 ? (r.total_portfolio_value / r.spy_equivalent_value - 1) * 100 : NaN;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(r.timestamp_utc)}</td><td>${fmtUsd(r.total_portfolio_value)}</td><td>${fmtUsd(r.spy_equivalent_value)}</td>
          <td style="color:${d >= 0 ? "var(--pos)" : "var(--neg)"}">${fmtUsd(d)}</td>
          <td style="color:${dp >= 0 ? "var(--pos)" : "var(--neg)"}">${Number.isFinite(dp) ? dp.toFixed(2) + "%" : "—"}</td>`;
    tbody.appendChild(tr);
  }
}

function renderChart(rows) {
  const chartNote = document.getElementById("chartNote");
  const canvas = document.getElementById("chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (window._benchChart) window._benchChart.destroy();
  window._benchChart = null;
  if (chartNote) {
    chartNote.textContent =
      rows.length === 0
        ? document.body.dataset.statsMissing === "1"
          ? "No stats file yet — run main.py once to append portfolio_stats.csv."
          : "No rows in stats CSV."
        : `${rows.length} run(s) logged`;
  }
  if (rows.length === 0 || typeof Chart === "undefined") return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4d9fff";
  const spyC = getComputedStyle(document.documentElement).getPropertyValue("--spy").trim() || "#ffb020";
  const labels = rows.map((r) => r.timestamp_utc.slice(0, 10));
  const portfolio = rows.map((r) => r.total_portfolio_value);
  const spyEq = rows.map((r) => r.spy_equivalent_value);
  window._benchChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Portfolio", data: portfolio, borderColor: accent, tension: 0.2, fill: false, borderWidth: 2 },
        { label: "SPY equivalent", data: spyEq, borderColor: spyC, tension: 0.2, fill: false, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() },
        },
        tooltip: {
          callbacks: {
            label(c) {
              return c.dataset.label + ": " + fmtUsd(c.parsed.y);
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim(), maxRotation: 45 } },
        y: {
          ticks: {
            color: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim(),
            callback(v) {
              if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
              if (v >= 1e3) return (v / 1e3).toFixed(0) + "k";
              return v;
            },
          },
          grid: { color: "rgba(127,127,127,0.12)" },
        },
      },
    },
  });
}

function renderWatchlist(data, errEl, noteEl, scrollEl) {
  if (!errEl || !noteEl || !scrollEl) return;
  errEl.style.display = "none";
  scrollEl.style.display = "none";
  noteEl.textContent = "";
  if (data.error && !data.data) {
    errEl.textContent = data.message || data.error || "Could not load ratings.";
    errEl.style.display = "block";
    noteEl.textContent = "Is the rating engine running? Check RATING_ENGINE_URL on the server.";
    return;
  }
  const rows = data.data || [];
  const errs = data.errors || [];
  const period = data.period || "";
  noteEl.textContent = `Period ${period} · ${data.summary ? data.summary.ok + " ok" : rows.length} · ${data.summary ? data.summary.errors + " errors" : errs.length}`;
  if (!rows.length && !errs.length) {
    noteEl.textContent += " — no rows returned.";
    return;
  }
  scrollEl.style.display = "block";
  const thead = document.querySelector("#watchlistTable thead");
  const tbody = document.querySelector("#watchlistTable tbody");
  if (!thead || !tbody) return;
  thead.innerHTML = "<tr><th>Symbol</th><th>Score</th><th>Rating</th></tr>";
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    const rc = ratingClass(r.rating);
    tr.innerHTML = `<td><strong>${escapeHtml(r.ticker)}</strong></td><td>${r.score != null ? escapeHtml(String(r.score)) : "—"}</td>
          <td><span class="rating-badge ${rc}">${escapeHtml(r.rating || "—")}</span></td>`;
    tbody.appendChild(tr);
  }
  for (const e of errs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(e.ticker)}</td><td colspan="2" class="err">${escapeHtml(e.error || "")}</td>`;
    tbody.appendChild(tr);
  }
}

function renderModel(model) {
  const metaEl = document.getElementById("modelMeta");
  const modelErr = document.getElementById("modelErr");
  if (!metaEl) return;
  if (modelErr) modelErr.textContent = "";
  metaEl.innerHTML = "";
  if (model.error && !model.trained_at) {
    if (!modelErr) return;
    let msg = model.message || model.error || "Could not load model metadata.";
    if (String(msg).toLowerCase().includes("fetch") || String(msg).toLowerCase().includes("abort")) {
      msg = "Model service unreachable.";
    }
    modelErr.textContent = msg;
    return;
  }
  const inf = model.inference || {};
  const items = [
    ["Trained at (UTC)", model.trained_at],
    ["Feature pipeline", model.feature_pipeline],
    ["Precision floor", inf.probability_floor],
    ["Tune min precision", inf.tune_min_precision],
    ["Classifier", model.classifier],
    ["Training period", model.period],
  ];
  for (const [k, v] of items) {
    if (v === undefined || v === null || v === "") continue;
    const d = document.createElement("div");
    d.className = "meta-item";
    d.innerHTML =
      "<span>" + escapeHtml(k) + "</span>" + escapeHtml(typeof v === "object" ? JSON.stringify(v) : String(v));
    metaEl.appendChild(d);
  }
}

function renderPositions(positions) {
  const wrap = document.getElementById("posWrap");
  if (!wrap) return;
  if (!positions.enabled) {
    wrap.innerHTML = '<p class="note">' + escapeHtml(positions.note || "Alpaca keys not configured.") + "</p>";
  } else if (positions.error) {
    wrap.innerHTML = '<p class="err">' + escapeHtml(positions.error) + "</p>";
  } else if (!positions.positions || positions.positions.length === 0) {
    wrap.innerHTML =
      '<p class="note">No open positions · paper: ' + escapeHtml(String(positions.paper)) + "</p>";
  } else {
    const hdr =
      "<tr><th>Symbol</th><th>Qty</th><th>Avg entry</th><th>Last</th><th>Market value</th><th>Unrealized P/L</th><th>Unrealized P/L %</th></tr>";
    const body = positions.positions
      .map(
        (p) =>
          "<tr><td><strong>" +
          escapeHtml(p.symbol) +
          "</strong></td><td>" +
          escapeHtml(String(p.qty)) +
          "</td><td>" +
          fmtUsd(p.avg_entry_price) +
          "</td><td>" +
          fmtUsd(p.current_price) +
          "</td><td>" +
          fmtUsd(p.market_value) +
          "</td><td style=\"color:" +
          (Number(p.unrealized_pl) >= 0 ? "var(--pos)" : "var(--neg)") +
          "\">" +
          fmtUsd(p.unrealized_pl) +
          "</td><td>" +
          fmtPct(p.unrealized_plpc) +
          "</td></tr>"
      )
      .join("");
    wrap.innerHTML =
      '<p class="note">Paper account: <strong>' +
      escapeHtml(String(positions.paper)) +
      '</strong></p><div class="table-scroll"><table class="data"><thead>' +
      hdr +
      "</thead><tbody>" +
      body +
      "</tbody></table></div>";
  }
}

async function loadStatusPills() {
  const [hRes, statsRes, posRes] = await Promise.all([
    fetch("/api/engine-health"),
    fetch("/api/stats"),
    fetch("/api/positions"),
  ]);
  const health = await hRes.json().catch(() => ({}));
  const stats = await statsRes.json().catch(() => ({ rows: [] }));
  const positions = await posRes.json().catch(() => ({ enabled: false }));
  const healthOk = hRes.ok && health.status === "ok";
  const rows = stats.rows || [];
  let statsState = "empty";
  if (stats.note === "stats_file_missing") {
    statsState = "missing";
    document.body.dataset.statsMissing = "1";
  } else if (rows.length > 0) statsState = "ok";
  let alpaca = "off";
  if (positions.enabled) alpaca = positions.error ? "err" : "ok";
  setPills({ healthOk, statsState, sourceFile: stats.source_file, alpaca });
  return { healthOk, stats, positions, rows };
}

async function loadHome() {
  await loadStatusPills();
  const foot = document.getElementById("footMeta");
  if (foot) foot.textContent = "Last loaded " + new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

async function loadBenchmark() {
  const modelErr = document.getElementById("modelErr");
  if (modelErr) modelErr.textContent = "";
  const { stats, rows } = await loadStatusPills();
  renderKpis(rows);
  renderStatsTable(rows);
  renderChart(rows);
  const foot = document.getElementById("footMeta");
  if (foot) foot.textContent = "Last loaded " + new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

async function loadWatchlistPage() {
  await loadStatusPills();
  const watchErr = document.getElementById("watchlistErr");
  const watchNote = document.getElementById("watchlistNote");
  const watchScroll = document.getElementById("watchlistScroll");
  if (watchErr) watchErr.textContent = "";
  let ratings = {};
  try {
    const rRat = await fetch("/api/ratings?period=2y&details=0");
    ratings = await rRat.json().catch(() => ({}));
    if (!rRat.ok) ratings = { error: true, message: ratings.message || ratings.error || rRat.statusText };
  } catch (e) {
    ratings = { error: true, message: String(e) };
  }
  if (watchErr && watchNote && watchScroll) renderWatchlist(ratings, watchErr, watchNote, watchScroll);
  const foot = document.getElementById("footMeta");
  if (foot) foot.textContent = "Last loaded " + new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

async function loadModelPage() {
  await loadStatusPills();
  const modelRes = await fetch("/api/model");
  const model = await modelRes.json().catch(() => ({}));
  renderModel(model);
  const foot = document.getElementById("footMeta");
  if (foot) foot.textContent = "Last loaded " + new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

async function loadPositionsPage() {
  await loadStatusPills();
  const posRes = await fetch("/api/positions");
  const positions = await posRes.json().catch(() => ({ enabled: false }));
  renderPositions(positions);
  const foot = document.getElementById("footMeta");
  if (foot) foot.textContent = "Last loaded " + new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

async function loadCurrentPage() {
  setActiveNav();
  if (PAGE === "home") await loadHome();
  else if (PAGE === "benchmark") await loadBenchmark();
  else if (PAGE === "watchlist") await loadWatchlistPage();
  else if (PAGE === "model") await loadModelPage();
  else if (PAGE === "positions") await loadPositionsPage();
}

function wireChrome() {
  initTheme();
  const refresh = document.getElementById("btnRefresh");
  if (refresh) {
    refresh.addEventListener("click", () => {
      const pageErr = document.getElementById("pageErr");
      if (pageErr) {
        pageErr.textContent = "";
        pageErr.style.display = "none";
      }
      loadCurrentPage().catch((e) => {
        const el =
          document.getElementById("pageErr") ||
          document.getElementById("modelErr") ||
          document.getElementById("watchlistErr");
        if (el) {
          el.textContent = String(e);
          el.style.display = "block";
        }
      });
    });
  }
  const theme = document.getElementById("btnTheme");
  if (theme) {
    theme.addEventListener("click", () => {
      toggleTheme();
      loadCurrentPage().catch(() => {});
    });
  }
}

wireChrome();
loadCurrentPage().catch((e) => {
  const el =
    document.getElementById("pageErr") ||
    document.getElementById("modelErr") ||
    document.getElementById("watchlistErr");
  if (el) {
    el.textContent = String(e);
    el.style.display = "block";
  }
});
