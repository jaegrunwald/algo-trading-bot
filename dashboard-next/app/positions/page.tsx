"use client";
import { trpc } from "@/lib/trpc";

function fmtUsd(n: unknown) {
  const v = Number(n);
  return isFinite(v) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v) : "—";
}
function fmtPct(n: unknown) {
  const v = Number(n);
  return isFinite(v) ? (v * 100).toFixed(2) + "%" : "—";
}

export default function PositionsPage() {
  const { data, isLoading, error, refetch } = trpc.positions.list.useQuery(undefined, { refetchInterval: 30_000 });

  const positions = data?.positions ?? [];

  return (
    <div className="flex flex-col flex-1 gap-4">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[0.67rem] font-bold uppercase tracking-widest text-muted/65 mb-1">// Monitor · Positions</p>
          <h1 className="text-2xl font-bold tracking-tight">Open Positions</h1>
        </div>
        <button onClick={() => refetch()} className="text-xs font-semibold text-muted hover:text-text border border-border/50 rounded-lg px-3 py-1.5">
          ↻ Refresh
        </button>
      </div>

      <section className="bg-card rounded-xl border border-border/50 p-4 flex flex-col flex-1 min-h-0">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-[0.7rem] font-bold uppercase tracking-widest text-muted">Alpaca positions</h2>
          {data?.paper != null && (
            <span className="text-[0.7rem] font-semibold px-2 py-0.5 rounded-full border border-border/50 text-muted">
              Paper account: <strong className="text-text">{String(data.paper)}</strong>
            </span>
          )}
        </div>

        {isLoading && <p className="text-sm text-muted">Loading…</p>}
        {error && <p className="text-sm text-neg">{error.message}</p>}
        {!isLoading && !data?.enabled && (
          <p className="text-sm text-muted">Alpaca keys are not configured on the server.</p>
        )}
        {data?.error && (
          <p className="text-sm text-neg">{String(data.error)}</p>
        )}
        {data?.enabled && !data.error && positions.length === 0 && !isLoading && (
          <p className="text-sm text-muted">No open positions.</p>
        )}

        {positions.length > 0 && (
          <div className="overflow-auto flex-1 min-h-0 rounded-lg border border-border/40">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-[0.7rem] uppercase tracking-wide text-muted bg-card2 sticky top-0">
                  <th className="text-left px-3 py-2.5 font-semibold">Symbol</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Qty</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Avg Entry</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Last</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Market Value</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Unrealized P/L</th>
                  <th className="text-right px-3 py-2.5 font-semibold">P/L %</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pl = Number(p.unrealizedPl);
                  const col = pl >= 0 ? "text-pos" : "text-neg";
                  return (
                    <tr key={p.symbol} className="border-t border-border/30 hover:bg-card2/60 transition-colors">
                      <td className="px-3 py-2.5 font-bold">{p.symbol}</td>
                      <td className="px-3 py-2.5 text-right text-muted">{Number(p.qty).toFixed(4)}</td>
                      <td className="px-3 py-2.5 text-right">{fmtUsd(p.avgEntryPrice)}</td>
                      <td className="px-3 py-2.5 text-right">{fmtUsd(p.currentPrice)}</td>
                      <td className="px-3 py-2.5 text-right">{fmtUsd(p.marketValue)}</td>
                      <td className={`px-3 py-2.5 text-right font-semibold ${col}`}>{fmtUsd(pl)}</td>
                      <td className={`px-3 py-2.5 text-right ${col}`}>{fmtPct(p.unrealizedPlpc)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="mt-auto pt-3 border-t border-border/30 text-[0.78rem] text-muted">
        Last loaded {new Date().toLocaleString()}
      </footer>
    </div>
  );
}
