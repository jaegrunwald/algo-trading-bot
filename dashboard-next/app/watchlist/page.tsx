"use client";
import { trpc } from "@/lib/trpc";

function RatingBadge({ rating }: { rating: string }) {
  const r = rating.toLowerCase();
  const cls =
    r.includes("strong buy")  ? "bg-pos/15 text-pos border-pos/30" :
    r.includes("buy")         ? "bg-accent/15 text-accent border-accent/30" :
    r.includes("strong sell") ? "bg-neg/15 text-neg border-neg/30" :
    r.includes("sell")        ? "bg-neg/10 text-neg border-neg/20" :
    r.includes("hold")        ? "bg-spy/10 text-spy border-spy/25" :
    "bg-card2 text-muted border-border/50";
  return (
    <span className={`text-[0.7rem] font-bold px-2 py-0.5 rounded border ${cls}`}>{rating}</span>
  );
}

export default function WatchlistPage() {
  const { data, isLoading, error, refetch, isFetching } = trpc.ratings.list.useQuery();

  const rows  = data?.data  ?? [];
  const errs  = data?.errors ?? [];

  return (
    <div className="flex flex-col flex-1 gap-4">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[0.67rem] font-bold uppercase tracking-widest text-muted/65 mb-1">// Analyze · Watchlist ML</p>
          <h1 className="text-2xl font-bold tracking-tight">ML Ratings</h1>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="text-xs font-semibold text-muted hover:text-text border border-border/50 rounded-lg px-3 py-1.5 disabled:opacity-40">
          {isFetching ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      <section className="bg-card rounded-xl border border-border/50 p-4 flex flex-col flex-1 min-h-0">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-[0.7rem] font-bold uppercase tracking-widest text-muted">
            Watchlist — <code className="text-[0.75rem] bg-bg2 px-1.5 py-0.5 rounded">WATCHLIST_TICKERS</code>
          </h2>
          {data?.summary && (
            <span className="text-[0.7rem] text-muted">
              {data.summary.ok} rated · {data.summary.errors} errors · period {data.period}
            </span>
          )}
        </div>

        {isLoading && <p className="text-sm text-muted">Loading ratings — this may take up to a minute…</p>}
        {error && (
          <div>
            <p className="text-sm text-neg mb-1">{error.message}</p>
            <p className="text-sm text-muted">Is the rating engine running? Check <code className="bg-bg2 px-1 rounded">RATING_ENGINE_URL</code>.</p>
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-auto flex-1 min-h-0 rounded-lg border border-border/40">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-[0.7rem] uppercase tracking-wide text-muted bg-card2 sticky top-0">
                  <th className="text-left px-3 py-2.5 font-semibold">Symbol</th>
                  <th className="text-right px-3 py-2.5 font-semibold">Score</th>
                  <th className="text-left px-3 py-2.5 font-semibold">Rating</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ticker} className="border-t border-border/30 hover:bg-card2/60 transition-colors">
                    <td className="px-3 py-2.5 font-bold">{r.ticker}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{r.score ?? "—"}</td>
                    <td className="px-3 py-2.5"><RatingBadge rating={r.rating ?? "—"} /></td>
                  </tr>
                ))}
                {errs.map((e) => (
                  <tr key={e.ticker} className="border-t border-border/30">
                    <td className="px-3 py-2.5 font-bold text-muted">{e.ticker}</td>
                    <td colSpan={2} className="px-3 py-2.5 text-neg text-xs">{e.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="mt-auto pt-3 border-t border-border/30 text-[0.78rem] text-muted">
        Ratings fetched on demand · click Refresh to re-run
      </footer>
    </div>
  );
}
