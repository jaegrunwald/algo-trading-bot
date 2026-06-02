"use client";
import { trpc } from "@/lib/trpc";

export function Header() {
  const health = trpc.ratings.health.useQuery(undefined, { refetchInterval: 30_000 });
  const positions = trpc.positions.list.useQuery(undefined, { refetchInterval: 30_000 });
  const stats = trpc.stats.list.useQuery(undefined, { refetchInterval: 60_000 });

  const engineOk = health.data?.ok;
  const alpacaOk = positions.data?.enabled && !positions.data?.error;
  const statsOk  = (stats.data?.length ?? 0) > 0;

  return (
    <header className="flex flex-wrap items-center gap-3 px-5 py-3 bg-card border-b border-border/50 flex-shrink-0">
      <h1 className="text-lg font-bold tracking-tight mr-2">Trading Hub</h1>

      <div className="flex flex-wrap gap-2 ml-auto items-center">
        <Pill ok={statsOk}  label={statsOk  ? "Stats OK"       : "No stats"} />
        <Pill ok={!!engineOk} label={engineOk ? "Rating API OK" : "Rating API down"} />
        <Pill ok={!!alpacaOk} label={alpacaOk ? "Alpaca OK"     : positions.data?.enabled ? "Alpaca error" : "Alpaca off"} />
      </div>
    </header>
  );
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
        ok
          ? "text-pos border-pos/40 bg-pos/10"
          : "text-muted border-border"
      }`}
    >
      {label}
    </span>
  );
}
