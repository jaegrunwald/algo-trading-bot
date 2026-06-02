"use client";
import { trpc } from "@/lib/trpc";

function MetaCard({ label, value }: { label: string; value: string | null | undefined }) {
  if (value == null || value === "") return null;
  return (
    <div className="bg-card2 rounded-lg border border-border/50 px-4 py-3">
      <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted mb-1.5">{label}</div>
      <div className="text-sm font-medium text-text break-all">{value}</div>
    </div>
  );
}

export default function ModelPage() {
  const { data, isLoading, error, refetch } = trpc.model.get.useQuery();

  const inf = (data?.inference ?? {}) as Record<string, unknown>;

  return (
    <div className="flex flex-col flex-1 gap-4">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[0.67rem] font-bold uppercase tracking-widest text-muted/65 mb-1">// Analyze · Model</p>
          <h1 className="text-2xl font-bold tracking-tight">Model Metadata</h1>
        </div>
        <button onClick={() => refetch()} className="text-xs font-semibold text-muted hover:text-text border border-border/50 rounded-lg px-3 py-1.5">
          ↻ Refresh
        </button>
      </div>

      <section className="bg-card rounded-xl border border-border/50 p-4">
        <h2 className="text-[0.7rem] font-bold uppercase tracking-widest text-muted mb-4">Trained classifier</h2>

        {isLoading && <p className="text-sm text-muted">Loading…</p>}
        {error && (
          <div>
            <p className="text-sm text-neg">{error.message}</p>
            <p className="text-sm text-muted mt-1">Is the rating engine running?</p>
          </div>
        )}

        {data && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <MetaCard label="Trained at" value={data.trainedAt ? new Date(data.trainedAt).toLocaleString() : null} />
            <MetaCard label="Feature pipeline" value={data.featurePipeline} />
            <MetaCard label="Classifier" value={data.classifier} />
            <MetaCard label="Training period" value={data.period} />
            <MetaCard label="Precision floor" value={inf.probability_floor != null ? String(inf.probability_floor) : null} />
            <MetaCard label="Tune min precision" value={inf.tune_min_precision != null ? String(inf.tune_min_precision) : null} />
          </div>
        )}
      </section>

      <footer className="mt-auto pt-3 border-t border-border/30 text-[0.78rem] text-muted">
        Metadata served by the rating engine
      </footer>
    </div>
  );
}
