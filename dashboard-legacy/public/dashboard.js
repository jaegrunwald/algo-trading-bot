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
/** Browser local timezone (e.g. America/Los_Angeles). CSV rows are still stored as UTC on the server. */
function localTimeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

function fmtLocalDateTime(iso, { withSeconds = false } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const opts = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  if (withSeconds) opts.second = "2-digit";
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

function fmtFootLoaded(extra = "") {
  return (
    `Last loaded ${fmtLocalDateTime(new Date().toISOString(), { withSeconds: true })} (${localTimeZoneName()})` +
    extra
  );
}

/** X-axis label from ISO timestamp (local hour bucket). */
function fmtChartAxisTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:00`;
}

function fmtChartTooltipTime(iso) {
  return `${fmtLocalDateTime(iso, { withSeconds: true })} (${localTimeZoneName()})`;
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
  if (window._benchChart) { window._benchChart.destroy(); window._benchChart = null; }
  if (window._homeChart)  { window._homeChart.destroy();  window._homeChart  = null; }
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
        <div class="kpi"><span>Portfolio (last)</span><strong>${fmtUsd(pv)}</strong><small>${escapeHtml(fmtLocalDateTime(last.timestamp_utc, { withSeconds: true }))}</small></div>
        <div class="kpi"><span>SPY equivalent</span><strong>${fmtUsd(spy)}</strong><small>Buy &amp; hold benchmark</small></div>
        <div class="kpi"><span>Δ vs SPY ($)</span><strong style="color:${delta >= 0 ? "var(--pos)" : "var(--neg)"}">${fmtUsd(delta)}</strong><small>portfolio − benchmark</small></div>
        <div class="kpi"><span>Δ vs SPY (%)</span><strong style="color:${deltaPct >= 0 ? "var(--pos)" : "var(--neg)"}">${Number.isFinite(deltaPct) ? deltaPct.toFixed(2) + "%" : "—"}</strong><small>${rows.length} run(s) logged</small></div>`;
}

function renderStatsTable(rows) {
  const thead = document.querySelector("#statsTable thead");
  const tbody = document.querySelector("#statsTable tbody");
  if (!thead || !tbody) return;
  thead.innerHTML = `<tr><th>Time (${escapeHtml(localTimeZoneName())})</th><th>Portfolio</th><th>SPY eq.</th><th>Δ $</th><th>Δ %</th></tr>`;
  tbody.innerHTML = "";
  const rev = rows.slice().reverse().slice(0, 80);
  for (const r of rev) {
    const d = r.total_portfolio_value - r.spy_equivalent_value;
    const dp = r.spy_equivalent_value > 0 ? (r.total_portfolio_value / r.spy_equivalent_value - 1) * 100 : NaN;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(fmtLocalDateTime(r.timestamp_utc, { withSeconds: true }))}</td><td>${fmtUsd(r.total_portfolio_value)}</td><td>${fmtUsd(r.spy_equivalent_value)}</td>
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
  const labels = rows.map((r) => fmtChartAxisTime(r.timestamp_utc));
  const timestamps = rows.map((r) => r.timestamp_utc);
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
            title(items) {
              const i = items[0] && items[0].dataIndex;
              return i != null && timestamps[i] ? fmtChartTooltipTime(timestamps[i]) : "";
            },
            label(c) {
              return c.dataset.label + ": " + fmtUsd(c.parsed.y);
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim(),
            maxRotation: 45,
            autoSkip: true,
            maxTicksLimit: 14,
          },
        },
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
    [`Trained at (${localTimeZoneName()})`, model.trained_at ? fmtLocalDateTime(model.trained_at, { withSeconds: true }) : model.trained_at],
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

function statsFetchUrl() {
  return `/api/stats?_=${Date.now()}`;
}

// ── Sidebar schedule widget (runs on every page) ─────────────────────────────

let _sidebarPollTimer     = null;
let _sidebarCountdownTimer = null;
let _sidebarNextRunAt     = null;

function fmtCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function updateSidebarCountdown() {
  const el = document.getElementById("swCountdown");
  if (!el) return;
  el.textContent = _sidebarNextRunAt ? fmtCountdown(new Date(_sidebarNextRunAt) - new Date()) : "--:--:--";
}

function applySidebarData(data) {
  const cfg = data.config || {};
  _sidebarNextRunAt = cfg.enabled && data.nextRunAt ? data.nextRunAt : null;
  const dotEl    = document.getElementById("swDot");
  const statusEl = document.getElementById("swStatus");
  const labelEl  = document.getElementById("swCountdownLabel");
  const toggleEl = document.getElementById("swAutoRun");
  if (dotEl)    dotEl.className   = "sw-dot " + (data.running ? "running" : "idle");
  if (statusEl) statusEl.textContent = data.running ? "Running" : "Idle";
  if (labelEl)  labelEl.textContent  = data.running ? "bot is running" : (cfg.enabled ? "until next run" : "scheduler off");
  if (toggleEl && toggleEl !== document.activeElement) toggleEl.checked = Boolean(cfg.enabled);
  updateSidebarCountdown();
}

async function initSidebar() {
  try { applySidebarData(await (await fetch("/api/scheduler")).json()); } catch { /* ignore */ }

  if (_sidebarCountdownTimer) clearInterval(_sidebarCountdownTimer);
  _sidebarCountdownTimer = setInterval(updateSidebarCountdown, 1000);

  if (_sidebarPollTimer) clearInterval(_sidebarPollTimer);
  _sidebarPollTimer = setInterval(async () => {
    try { applySidebarData(await (await fetch("/api/scheduler")).json()); } catch { /* ignore */ }
  }, 5000);

  const toggleEl = document.getElementById("swAutoRun");
  if (toggleEl) {
    toggleEl.addEventListener("change", async () => {
      try {
        const cur = await (await fetch("/api/scheduler")).json();
        await fetch("/api/scheduler/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...cur.config, enabled: toggleEl.checked }),
        });
      } catch { /* ignore */ }
    });
  }

  window.addEventListener("pagehide", () => {
    if (_sidebarPollTimer)     clearInterval(_sidebarPollTimer);
    if (_sidebarCountdownTimer) clearInterval(_sidebarCountdownTimer);
  }, { once: true });
}

// ── Home page render helpers ──────────────────────────────────────────────────

function renderHomeKpis(rows, positions) {
  const wrap = document.getElementById("homeKpis");
  if (!wrap) return;
  const last     = rows[rows.length - 1] || null;
  const pv       = last ? last.total_portfolio_value : null;
  const spy      = last ? last.spy_equivalent_value  : null;
  const delta    = pv != null && spy != null ? pv - spy : null;
  const deltaPct = spy > 0 ? (pv / spy - 1) * 100 : null;
  const posCount = positions.enabled && Array.isArray(positions.positions) ? positions.positions.length : null;
  const pos      = delta == null || delta >= 0;
  wrap.innerHTML = `
    <div class="kpi-large">
      <div class="kl-badge">Portfolio value</div>
      <div class="kl-value">${pv != null ? fmtUsd(pv) : "—"}</div>
      <div class="kl-sub">${last ? fmtLocalDateTime(last.timestamp_utc) : "No data yet"}</div>
    </div>
    <div class="kpi-large">
      <div class="kl-badge">SPY equivalent</div>
      <div class="kl-value">${spy != null ? fmtUsd(spy) : "—"}</div>
      <div class="kl-sub">Buy &amp; hold benchmark</div>
    </div>
    <div class="kpi-large ${delta == null ? "" : pos ? "kl-pos" : "kl-neg"}">
      <div class="kl-badge">Δ vs SPY</div>
      <div class="kl-value" style="color:${delta == null ? "inherit" : pos ? "var(--pos)" : "var(--neg)"}">${delta != null ? fmtUsd(delta) : "—"}</div>
      <div class="kl-sub">${deltaPct != null ? (deltaPct >= 0 ? "+" : "") + deltaPct.toFixed(2) + "% vs benchmark" : "—"}</div>
    </div>
    <div class="kpi-large">
      <div class="kl-badge">Open positions</div>
      <div class="kl-value">${posCount != null ? posCount : "—"}</div>
      <div class="kl-sub">${positions.enabled ? (positions.paper ? "Paper account" : "Live account") : "Alpaca not configured"}</div>
    </div>`;
}

function renderHomePositions(positions) {
  const wrap = document.getElementById("homePosWrap");
  if (!wrap) return;
  if (!positions.enabled) {
    wrap.innerHTML = '<p class="note">Alpaca keys not configured on server.</p>'; return;
  }
  if (positions.error) {
    wrap.innerHTML = `<p class="err">${escapeHtml(positions.error)}</p>`; return;
  }
  const list = (positions.positions || []).slice(0, 8);
  if (!list.length) {
    wrap.innerHTML = '<p class="note">No open positions.</p>'; return;
  }
  const rows = list.map(p => {
    const pl   = Number(p.unrealized_pl);
    const plpc = Number(p.unrealized_plpc);
    const col  = pl >= 0 ? "var(--pos)" : "var(--neg)";
    return `<tr>
      <td><strong>${escapeHtml(p.symbol)}</strong></td>
      <td>${escapeHtml(String(p.qty))}</td>
      <td>${fmtUsd(p.market_value)}</td>
      <td style="color:${col}">${fmtUsd(pl)}</td>
      <td style="color:${col}">${fmtPct(plpc)}</td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `
    <div class="table-scroll" style="max-height:220px">
      <table class="data">
        <thead><tr><th>Symbol</th><th>Qty</th><th>Value</th><th>P/L</th><th>P/L %</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderHomeMiniChart(rows) {
  const canvas = document.getElementById("homeChart");
  const note   = document.getElementById("homeChartNote");
  if (!canvas || typeof Chart === "undefined") return;
  if (window._homeChart) { window._homeChart.destroy(); window._homeChart = null; }
  const recent = rows.slice(-30);
  if (note) note.textContent = recent.length ? `${rows.length} run(s) logged` : "No stats yet — run main.py once.";
  if (!recent.length) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const spyC   = getComputedStyle(document.documentElement).getPropertyValue("--spy").trim();
  const muted  = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim();
  window._homeChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: recent.map(r => fmtChartAxisTime(r.timestamp_utc)),
      datasets: [
        { label: "Portfolio", data: recent.map(r => r.total_portfolio_value), borderColor: accent, tension: 0.3, fill: false, borderWidth: 2, pointRadius: 0 },
        { label: "SPY eq.",   data: recent.map(r => r.spy_equivalent_value),  borderColor: spyC,   tension: 0.3, fill: false, borderWidth: 2, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: muted, boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => c.dataset.label + ": " + fmtUsd(c.parsed.y) } },
      },
      scales: {
        x: { display: false },
        y: { ticks: { color: muted, callback: v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v } },
      },
    },
  });
}

function renderHomeBotLog(sched) {
  const wrap = document.getElementById("homeBotLog");
  if (!wrap) return;
  const logs = (sched.recentLogs || []).slice(-10).reverse();
  if (!logs.length) {
    wrap.innerHTML = '<span class="trace-empty">No bot activity yet.</span>'; return;
  }
  wrap.innerHTML = logs.map(line => {
    const time = new Date(line.time).toLocaleTimeString("en-US", { hour12: false });
    return `<div class="trace-line">
      <span class="trace-time">${escapeHtml(time)}</span>
      <span class="trace-tag ${escapeHtml(line.tag)}">${escapeHtml(line.tag)}</span>
      <span class="trace-msg">${escapeHtml(line.msg)}</span>
    </div>`;
  }).join("");
}

// ── Scheduler page ─────────────────────────────────────────────────────────────

let _schedulerStream = null;
let _schedulerPollTimer = null;

function appendTraceLine(line, panel) {
  const empty = panel.querySelector(".trace-empty");
  if (empty) empty.remove();
  const d = document.createElement("div");
  d.className = "trace-line";
  const time = new Date(line.time).toLocaleTimeString("en-US", { hour12: false });
  d.innerHTML =
    `<span class="trace-time">${escapeHtml(time)}</span>` +
    `<span class="trace-tag ${escapeHtml(line.tag)}">${escapeHtml(line.tag)}</span>` +
    `<span class="trace-msg">${escapeHtml(line.msg)}</span>`;
  panel.appendChild(d);
  panel.scrollTop = panel.scrollHeight;
}

function updateSchedulerStatus(data) {
  const runningEl  = document.getElementById("schedRunning");
  const enabledPill = document.getElementById("schedEnabled");
  const lastRunEl  = document.getElementById("schedLastRun");
  const nextRunEl  = document.getElementById("schedNextRun");
  const runBtn     = document.getElementById("btnRunNow");
  const stopBtn    = document.getElementById("btnStop");

  if (runningEl) {
    runningEl.textContent = data.running ? "Running" : "Idle";
    runningEl.className   = "pill " + (data.running ? "running" : "idle");
  }
  if (enabledPill) {
    enabledPill.style.display = data.config && data.config.enabled ? "" : "none";
  }
  if (lastRunEl) {
    lastRunEl.textContent = data.lastRunAt
      ? `Last run: ${fmtLocalDateTime(data.lastRunAt, { withSeconds: true })}`
      : "Last run: —";
  }
  if (nextRunEl) {
    nextRunEl.textContent = data.nextRunAt
      ? `Next run: ${fmtLocalDateTime(data.nextRunAt, { withSeconds: true })}`
      : (data.config && data.config.enabled ? "Next run: —" : "Auto-run disabled");
  }
  if (runBtn)  runBtn.disabled  = data.running;
  if (stopBtn) stopBtn.disabled = !data.running;
}

async function loadSchedulerPage() {
  await loadStatusPills();

  const tracePanel   = document.getElementById("tracePanel");
  const intervalEl   = document.getElementById("cfgInterval");
  const customIntEl  = document.getElementById("cfgCustomInterval");
  const customRow    = document.getElementById("customIntervalRow");
  const enabledEl    = document.getElementById("cfgEnabled");
  const hoursStartEl = document.getElementById("cfgHoursStart");
  const hoursEndEl   = document.getElementById("cfgHoursEnd");
  const dryRunEl     = document.getElementById("cfgDryRun");
  const wlLimitEl    = document.getElementById("cfgWatchlistLimit");

  let data;
  try {
    const r = await fetch("/api/scheduler");
    data = await r.json();
  } catch {
    data = { config: {}, running: false, lastRunAt: null, nextRunAt: null, recentLogs: [] };
  }

  const cfg = data.config || {};
  if (enabledEl)    enabledEl.checked  = Boolean(cfg.enabled);
  if (hoursStartEl) hoursStartEl.value = cfg.hoursStart ?? 9;
  if (hoursEndEl)   hoursEndEl.value   = cfg.hoursEnd   ?? 16;
  if (dryRunEl)     dryRunEl.checked   = Boolean(cfg.dryRun);
  if (wlLimitEl)    wlLimitEl.value    = cfg.watchlistLimit ?? 50;

  const presets = ["15", "30", "60", "120", "240", "480"];
  const savedInterval = String(cfg.intervalMinutes ?? 60);
  if (intervalEl && customIntEl && customRow) {
    if (presets.includes(savedInterval)) {
      intervalEl.value        = savedInterval;
      customRow.style.display = "none";
    } else {
      intervalEl.value        = "custom";
      customIntEl.value       = savedInterval;
      customRow.style.display = "";
    }
    intervalEl.addEventListener("change", () => {
      customRow.style.display = intervalEl.value === "custom" ? "" : "none";
    });
  }

  updateSchedulerStatus(data);

  if (tracePanel && data.recentLogs && data.recentLogs.length) {
    for (const line of data.recentLogs) appendTraceLine(line, tracePanel);
  }

  if (_schedulerStream) _schedulerStream.close();
  _schedulerStream = new EventSource("/api/scheduler/stream");
  _schedulerStream.onmessage = (ev) => {
    try { if (tracePanel) appendTraceLine(JSON.parse(ev.data), tracePanel); } catch { /* ignore */ }
  };

  if (_schedulerPollTimer) clearInterval(_schedulerPollTimer);
  _schedulerPollTimer = setInterval(async () => {
    try {
      const r = await fetch("/api/scheduler");
      updateSchedulerStatus(await r.json());
    } catch { /* ignore */ }
  }, 3000);

  window.addEventListener("pagehide", () => {
    if (_schedulerStream)    _schedulerStream.close();
    if (_schedulerPollTimer) clearInterval(_schedulerPollTimer);
  }, { once: true });

  const saveBtn = document.getElementById("btnSaveConfig");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const intervalMinutes = intervalEl && intervalEl.value === "custom"
        ? Number(customIntEl?.value || 60)
        : Number(intervalEl?.value ?? 60);
      const payload = {
        enabled:        enabledEl?.checked        ?? false,
        intervalMinutes,
        hoursStart:     Number(hoursStartEl?.value ?? 9),
        hoursEnd:       Number(hoursEndEl?.value   ?? 16),
        dryRun:         dryRunEl?.checked          ?? false,
        watchlistLimit: Number(wlLimitEl?.value    ?? 50),
      };
      saveBtn.disabled    = true;
      saveBtn.textContent = "Saving…";
      try {
        const r = await fetch("/api/scheduler/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        updateSchedulerStatus({ running: data.running, config: d.config, nextRunAt: d.nextRunAt });
        saveBtn.textContent = "Saved ✓";
      } catch {
        saveBtn.textContent = "Error";
      }
      setTimeout(() => { saveBtn.textContent = "Save settings"; saveBtn.disabled = false; }, 1800);
    });
  }

  const runBtn = document.getElementById("btnRunNow");
  if (runBtn) {
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      try {
        const r = await fetch("/api/scheduler/run-now", { method: "POST" });
        const d = await r.json();
        if (!d.ok) runBtn.disabled = false;
      } catch {
        runBtn.disabled = false;
      }
    });
  }

  const stopBtn = document.getElementById("btnStop");
  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      try { await fetch("/api/scheduler/stop", { method: "POST" }); } catch { /* ignore */ }
    });
  }

  const foot = document.getElementById("footMeta");
  if (foot) foot.textContent = fmtFootLoaded();
}

// ──────────────────────────────────────────────────────────────────────────────

let _autoRefreshTimer = null;
const BENCHMARK_AUTO_REFRESH_MS = 60_000;

function startAutoRefresh() {
  if (_autoRefreshTimer) clearInterval(_autoRefreshTimer);
  if (PAGE !== "benchmark" && PAGE !== "home") return;
  _autoRefreshTimer = setInterval(() => {
    loadCurrentPage().catch(() => {});
  }, BENCHMARK_AUTO_REFRESH_MS);
}

async function loadStatusPills() {
  const [hRes, statsRes, posRes] = await Promise.all([
    fetch("/api/engine-health"),
    fetch(statsFetchUrl()),
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
  const [statsRes, posRes, schedRes, healthRes] = await Promise.all([
    fetch(statsFetchUrl()),
    fetch("/api/positions"),
    fetch("/api/scheduler"),
    fetch("/api/engine-health"),
  ]);
  const stats     = await statsRes.json().catch(() => ({ rows: [] }));
  const positions = await posRes.json().catch(() => ({ enabled: false, positions: [] }));
  const sched     = await schedRes.json().catch(() => ({ running: false, config: {}, recentLogs: [] }));
  const health    = await healthRes.json().catch(() => ({}));

  const rows     = stats.rows || [];
  const healthOk = healthRes.ok && health.status === "ok";
  let statsState = rows.length > 0 ? "ok" : (stats.note === "stats_file_missing" ? "missing" : "empty");
  let alpaca     = positions.enabled ? (positions.error ? "err" : "ok") : "off";
  setPills({ healthOk, statsState, sourceFile: stats.source_file, alpaca });

  renderHomeKpis(rows, positions);
  renderHomePositions(positions);
  renderHomeMiniChart(rows);
  renderHomeBotLog(sched);
  applySidebarData(sched);

  const foot = document.getElementById("footMeta");
  if (foot) foot.textContent = fmtFootLoaded();
  startAutoRefresh();
}

async function loadBenchmark() {
  const modelErr = document.getElementById("modelErr");
  if (modelErr) modelErr.textContent = "";
  const { stats, rows } = await loadStatusPills();
  renderKpis(rows);
  renderStatsTable(rows);
  renderChart(rows);
  const foot = document.getElementById("footMeta");
  if (foot) {
    const src = stats.updated_at
      ? ` · file updated ${fmtLocalDateTime(stats.updated_at, { withSeconds: true })}`
      : "";
    foot.textContent = fmtFootLoaded(src);
  }
  startAutoRefresh();
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
  if (foot) foot.textContent = fmtFootLoaded();
}

async function loadModelPage() {
  await loadStatusPills();
  const modelRes = await fetch("/api/model");
  const model = await modelRes.json().catch(() => ({}));
  renderModel(model);
  const foot = document.getElementById("footMeta");
  if (foot) foot.textContent = fmtFootLoaded();
}

async function loadPositionsPage() {
  await loadStatusPills();
  const posRes = await fetch("/api/positions");
  const positions = await posRes.json().catch(() => ({ enabled: false }));
  renderPositions(positions);
  const foot = document.getElementById("footMeta");
  if (foot) foot.textContent = fmtFootLoaded();
}

async function loadCurrentPage() {
  setActiveNav();
  if (PAGE === "home") await loadHome();
  else if (PAGE === "benchmark") await loadBenchmark();
  else if (PAGE === "watchlist") await loadWatchlistPage();
  else if (PAGE === "model") await loadModelPage();
  else if (PAGE === "positions") await loadPositionsPage();
  else if (PAGE === "scheduler") await loadSchedulerPage();
}

function wireChrome() {
  initTheme();
  initSidebar();
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
loadCurrentPage()
  .then(() => startAutoRefresh())
  .catch((e) => {
  const el =
    document.getElementById("pageErr") ||
    document.getElementById("modelErr") ||
    document.getElementById("watchlistErr");
  if (el) {
    el.textContent = String(e);
    el.style.display = "block";
  }
});
