"use client";
import Link from "next/link";
import { trpc } from "@/lib/trpc";

function fmtUsd(n: number | string | null | undefined) {
  const v = Number(n);
  if (!isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v);
}
function fmtPct(n: number | string | null | undefined) {
  const v = Number(n);
  if (!isFinite(v)) return "—";
  return (v * 100).toFixed(2) + "%";
}

function KpiCard({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean | null }) {
  return (
    <div className={`bg-card rounded-xl border p-4 ${positive === true ? "border-pos/20" : positive === false ? "border-neg/25 bg-neg/5" : "border-border/50"}`}>
      <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted mb-2">{label}</div>
      <div className={`text-2xl font-bold tabular-nums leading-none ${positive === true ? "text-pos" : positive === false ? "text-neg" : "text-text"}`}>{value}</div>
      {sub && <div className="text-[0.74rem] text-muted mt-1.5">{sub}</div>}
    </div>
  );
}

function Panel({ title, href, linkLabel, children }: { title: string; href?: string; linkLabel?: string; children: React.ReactNode }) {
  return (
    <section className="bg-card rounded-xl border border-border/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[0.7rem] font-bold uppercase tracking-widest text-muted">{title}</h2>
        {href && <Link href={href} className="text-xs font-semibold text-accent/85 hover:text-accent">{linkLabel ?? "View all →"}</Link>}
      </div>
      {children}
    </section>
  );
}

export default function OverviewPage() {
  const stats     = trpc.stats.list.useQuery();
  const positions = trpc.positions.list.useQuery();
  const scheduler = trpc.scheduler.get.useQuery(undefined, { refetchInterval: 5000 });

  const rows    = stats.data ?? [];
  const last    = rows[rows.length - 1];
  const pv      = last?.portfolioValue ?? null;
  const spy     = last?.spyEquivalent  ?? null;
  const delta   = pv != null && spy != null ? pv - spy : null;
  const deltaPct= spy != null && spy > 0 && pv != null ? (pv / spy - 1) * 100 : null;
  const posCount= positions.data?.positions?.length ?? null;

  const posList = positions.data?.positions?.slice(0, 8) ?? [];
  const logs    = (scheduler.data?.recentLogs ?? []).slice(-10).reverse();

  return (
    <div className="flex flex-col gap-4 flex-1">
      {/* Breadcrumb */}
      <div>
        <p className="text-[0.67rem] font-bold uppercase tracking-widest text-muted/65 mb-1">// Monitor · Overview</p>
        <h1 className="text-2xl font-bold tracking-tight">Portfolio Dashboard</h1>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Portfolio value"  value={fmtUsd(pv)}   sub={last ? new Date(last.timestampUtc).toLocaleString() : "No data yet"} />
        <KpiCard label="SPY equivalent"   value={fmtUsd(spy)}  sub="Buy & hold benchmark" />
        <KpiCard label="Δ vs SPY"         value={delta != null ? fmtUsd(delta) : "—"} sub={deltaPct != null ? (deltaPct >= 0 ? "+" : "") + deltaPct.toFixed(2) + "% vs benchmark" : "—"} positive={delta != null ? delta >= 0 : null} />
        <KpiCard label="Open positions"   value={posCount != null ? String(posCount) : "—"} sub={positions.data?.enabled ? (positions.data.paper ? "Paper account" : "Live account") : "Alpaca not configured"} />
      </div>

      {/* Positions + log */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1">
        <Panel title="Open Positions" href="/positions" linkLabel="View all →">
          {!positions.data?.enabled ? (
            <p className="text-sm text-muted">Alpaca keys not configured on server.</p>
          ) : positions.data.error ? (
            <p className="text-sm text-neg">{String(positions.data.error)}</p>
          ) : posList.length === 0 ? (
            <p className="text-sm text-muted">No open positions.</p>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[0.7rem] uppercase tracking-wide text-muted">
                    <th className="pb-2">Symbol</th><th className="pb-2 text-right">Qty</th>
                    <th className="pb-2 text-right">Value</th><th className="pb-2 text-right">P/L</th>
                    <th className="pb-2 text-right">P/L %</th>
                  </tr>
                </thead>
                <tbody>
                  {posList.map((p) => {
                    const pl = Number(p.unrealizedPl);
                    const col = pl >= 0 ? "text-pos" : "text-neg";
                    return (
                      <tr key={p.symbol} className="border-t border-border/30 hover:bg-card2/50">
                        <td className="py-1.5 font-bold">{p.symbol}</td>
                        <td className="py-1.5 text-right text-muted">{Number(p.qty).toFixed(2)}</td>
                        <td className="py-1.5 text-right">{fmtUsd(p.marketValue)}</td>
                        <td className={`py-1.5 text-right ${col}`}>{fmtUsd(pl)}</td>
                        <td className={`py-1.5 text-right ${col}`}>{fmtPct(p.unrealizedPlpc)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Recent Bot Activity" href="/scheduler" linkLabel="Open scheduler →">
          <div className="font-mono text-xs flex flex-col gap-0.5 max-h-64 overflow-y-auto">
            {logs.length === 0 ? (
              <span className="text-muted italic">No activity yet.</span>
            ) : logs.map((line, i) => {
              const tagColors: Record<string, string> = {
                START: "text-accent", DONE: "text-pos", ERR: "text-neg",
                STOP: "text-spy", SKIP: "text-muted", INFO: "text-muted", LOG: "text-muted",
              };
              return (
                <div key={i} className="flex gap-2 items-baseline">
                  <span className="text-muted w-24 flex-shrink-0 text-[0.68rem]">
                    {new Date(line.createdAt).toLocaleTimeString("en-US", { hour12: false })}
                  </span>
                  <span className={`w-10 flex-shrink-0 font-bold text-[0.67rem] ${tagColors[line.tag] ?? "text-muted"}`}>{line.tag}</span>
                  <span className="text-text break-all">{line.message}</span>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      <footer className="mt-auto pt-3 border-t border-border/30 text-[0.78rem] text-muted">
        Last loaded {new Date().toLocaleString()} · No keys sent to browser.
      </footer>
    </div>
  );
}
