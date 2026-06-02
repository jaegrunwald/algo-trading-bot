"use client";
import { trpc } from "@/lib/trpc";
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend, CartesianGrid,
} from "recharts";

function fmtUsd(n: unknown) {
  const v = Number(n);
  return isFinite(v) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v) : "—";
}
function fmtDt(iso: Date | string) {
  return new Date(iso).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function BenchmarkPage() {
  const { data: rows = [], isLoading, refetch } = trpc.stats.list.useQuery(undefined, { refetchInterval: 60_000 });

  const last   = rows[rows.length - 1];
  const pv     = last?.portfolioValue ?? null;
  const spy    = last?.spyEquivalent  ?? null;
  const delta  = pv != null && spy != null ? pv - spy : null;
  const deltaPct = spy != null && spy > 0 && pv != null ? (pv / spy - 1) * 100 : null;

  const chartData = rows.slice(-100).map((r) => ({
    label: fmtDt(r.timestampUtc),
    portfolio: r.portfolioValue,
    spy: r.spyEquivalent,
  }));

  return (
    <div className="flex flex-col flex-1 gap-4">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[0.67rem] font-bold uppercase tracking-widest text-muted/65 mb-1">// Analyze · Benchmark</p>
          <h1 className="text-2xl font-bold tracking-tight">Portfolio vs SPY</h1>
        </div>
        <button onClick={() => refetch()} className="text-xs font-semibold text-muted hover:text-text border border-border/50 rounded-lg px-3 py-1.5">
          ↻ Refresh
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Portfolio (last)", value: fmtUsd(pv), sub: last ? fmtDt(last.timestampUtc) : "No data" },
          { label: "SPY equivalent",  value: fmtUsd(spy), sub: "Buy & hold benchmark" },
          { label: "Δ vs SPY ($)",    value: delta != null ? fmtUsd(delta) : "—", pos: delta != null ? delta >= 0 : null },
          { label: "Δ vs SPY (%)",    value: deltaPct != null ? (deltaPct >= 0 ? "+" : "") + deltaPct.toFixed(2) + "%" : "—", pos: deltaPct != null ? deltaPct >= 0 : null, sub: `${rows.length} run(s) logged` },
        ].map(({ label, value, sub, pos }) => (
          <div key={label} className={`bg-card rounded-xl border p-4 ${pos === true ? "border-pos/20" : pos === false ? "border-neg/25 bg-neg/5" : "border-border/50"}`}>
            <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted mb-2">{label}</div>
            <div className={`text-2xl font-bold tabular-nums ${pos === true ? "text-pos" : pos === false ? "text-neg" : "text-text"}`}>{value}</div>
            {sub && <div className="text-[0.74rem] text-muted mt-1">{sub}</div>}
          </div>
        ))}
      </div>

      {/* Chart */}
      <section className="bg-card rounded-xl border border-border/50 p-4">
        <h2 className="text-[0.7rem] font-bold uppercase tracking-widest text-muted mb-4">Portfolio vs SPY</h2>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted">Loading…</div>
        ) : chartData.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted">No data — run main.py once to log stats.</div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData} margin={{ top: 4, right: 4, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="label" tick={{ fill: "#8b9aaf", fontSize: 11 }} tickLine={false} minTickGap={40} />
              <YAxis tick={{ fill: "#8b9aaf", fontSize: 11 }} tickLine={false} axisLine={false}
                tickFormatter={(v) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`} />
              <Tooltip
                contentStyle={{ background: "#161f2c", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                formatter={(v, name) => [fmtUsd(v), name === "portfolio" ? "Portfolio" : "SPY eq."]}
              />
              <Legend formatter={(v) => v === "portfolio" ? "Portfolio" : "SPY equivalent"} wrapperStyle={{ fontSize: 12, color: "#8b9aaf" }} />
              <Line dataKey="portfolio" stroke="#4d9fff" strokeWidth={2} dot={false} />
              <Line dataKey="spy"       stroke="#ffb020" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

      {/* Run log table */}
      <section className="bg-card rounded-xl border border-border/50 p-4">
        <h2 className="text-[0.7rem] font-bold uppercase tracking-widest text-muted mb-3">Run log</h2>
        <div className="overflow-auto max-h-72 rounded-lg border border-border/40">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-[0.7rem] uppercase tracking-wide text-muted bg-card2 sticky top-0">
                <th className="text-left px-3 py-2 font-semibold">Time</th>
                <th className="text-right px-3 py-2 font-semibold">Portfolio</th>
                <th className="text-right px-3 py-2 font-semibold">SPY eq.</th>
                <th className="text-right px-3 py-2 font-semibold">Δ $</th>
                <th className="text-right px-3 py-2 font-semibold">Δ %</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().slice(0, 80).map((r, i) => {
                const d   = r.portfolioValue - r.spyEquivalent;
                const dp  = r.spyEquivalent > 0 ? (r.portfolioValue / r.spyEquivalent - 1) * 100 : NaN;
                const col = d >= 0 ? "text-pos" : "text-neg";
                return (
                  <tr key={i} className="border-t border-border/30 hover:bg-card2/60 transition-colors">
                    <td className="px-3 py-2">{fmtDt(r.timestampUtc)}</td>
                    <td className="px-3 py-2 text-right">{fmtUsd(r.portfolioValue)}</td>
                    <td className="px-3 py-2 text-right">{fmtUsd(r.spyEquivalent)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${col}`}>{fmtUsd(d)}</td>
                    <td className={`px-3 py-2 text-right ${col}`}>{isFinite(dp) ? (dp >= 0 ? "+" : "") + dp.toFixed(2) + "%" : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-auto pt-3 border-t border-border/30 text-[0.78rem] text-muted">
        Auto-refreshes every 60s · {rows.length} total run(s)
      </footer>
    </div>
  );
}
