"use client";
import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";

const TAG_COLORS: Record<string, string> = {
  START: "text-accent", DONE: "text-pos", ERR: "text-neg",
  STOP: "text-spy",    SKIP: "text-muted", INFO: "text-muted", LOG: "text-muted",
};

const INTERVALS = [
  { label: "Every 15 minutes", value: 15 },
  { label: "Every 30 minutes", value: 30 },
  { label: "Every 1 hour",     value: 60 },
  { label: "Every 2 hours",    value: 120 },
  { label: "Every 4 hours",    value: 240 },
  { label: "Every 8 hours",    value: 480 },
  { label: "Custom…",          value: -1 },
];

export default function SchedulerPage() {
  const utils   = trpc.useUtils();
  const { data, refetch } = trpc.scheduler.get.useQuery(undefined, { refetchInterval: 3000 });
  const setConfig = trpc.scheduler.setConfig.useMutation({ onSuccess: () => refetch() });
  const runNow  = trpc.scheduler.runNow.useMutation({ onSuccess: () => refetch() });
  const stop    = trpc.scheduler.stop.useMutation({ onSuccess: () => refetch() });

  const cfg = data?.config;
  const running = data?.running ?? false;

  // Form state
  const [enabled,        setEnabled]        = useState(false);
  const [intervalVal,    setIntervalVal]     = useState(60);
  const [customInterval, setCustomInterval]  = useState(60);
  const [hoursStart,     setHoursStart]      = useState(9);
  const [hoursEnd,       setHoursEnd]        = useState(16);
  const [dryRun,         setDryRun]          = useState(false);
  const [watchlistLimit, setWatchlistLimit]  = useState(50);
  const [saveState,      setSaveState]       = useState<"idle"|"saving"|"saved">("idle");

  // Sync form from fetched config (on first load only)
  const synced = useRef(false);
  useEffect(() => {
    if (!cfg || synced.current) return;
    synced.current = true;
    setEnabled(cfg.enabled);
    setHoursStart(cfg.hoursStart);
    setHoursEnd(cfg.hoursEnd);
    setDryRun(cfg.dryRun);
    setWatchlistLimit(cfg.watchlistLimit);
    const preset = INTERVALS.find((i) => i.value === cfg.intervalMinutes);
    if (preset) { setIntervalVal(cfg.intervalMinutes); }
    else         { setIntervalVal(-1); setCustomInterval(cfg.intervalMinutes); }
  }, [cfg]);

  const resolvedInterval = intervalVal === -1 ? customInterval : intervalVal;

  async function handleSave() {
    setSaveState("saving");
    await setConfig.mutateAsync({ enabled, intervalMinutes: resolvedInterval, hoursStart, hoursEnd, dryRun, watchlistLimit });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  }

  const logs = (data?.recentLogs ?? []).slice(-50).reverse();
  const logRef = useRef<HTMLDivElement>(null);

  // SSE live log stream
  useEffect(() => {
    const es = new EventSource("/api/scheduler/stream");
    es.onmessage = () => { utils.scheduler.get.invalidate(); };
    return () => es.close();
  }, [utils.scheduler.get]);

  return (
    <div className="flex flex-col flex-1 gap-4">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[0.67rem] font-bold uppercase tracking-widest text-muted/65 mb-1">// Control · Scheduler</p>
          <h1 className="text-2xl font-bold tracking-tight">Bot Scheduler</h1>
        </div>
      </div>

      {/* Status + controls */}
      <section className="bg-card rounded-xl border border-border/50 p-4">
        <h2 className="text-[0.7rem] font-bold uppercase tracking-widest text-muted mb-3">Bot status</h2>
        <div className="flex items-center gap-3 mb-3">
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${running ? "text-accent border-accent/40 bg-accent/10 animate-pulse" : "text-muted border-border/50"}`}>
            {running ? "Running" : "Idle"}
          </span>
          {cfg?.enabled && (
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full border text-pos border-pos/35 bg-pos/8">Auto-run on</span>
          )}
        </div>
        <div className="text-sm text-muted mb-4 space-y-0.5">
          <div>Last run: {data?.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : "—"}</div>
          <div>Next run: {cfg?.enabled && data?.nextRunAt ? new Date(data.nextRunAt).toLocaleString() : cfg?.enabled ? "—" : "Scheduler off"}</div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => runNow.mutate()} disabled={running || runNow.isPending}
            className="text-sm font-semibold px-4 py-1.5 rounded-lg border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-40 transition-colors">
            ▶ Run Now
          </button>
          <button onClick={() => stop.mutate()} disabled={!running || stop.isPending}
            className="text-sm font-semibold px-4 py-1.5 rounded-lg border border-neg/35 text-neg hover:bg-neg/10 disabled:opacity-40 transition-colors">
            ◼ Stop
          </button>
        </div>
      </section>

      {/* Settings + log */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1">
        <section className="bg-card rounded-xl border border-border/50 p-4">
          <h2 className="text-[0.7rem] font-bold uppercase tracking-widest text-muted mb-4">Schedule settings</h2>

          <label className="flex items-center justify-between mb-4">
            <span className="text-sm font-medium">Enable auto-run</span>
            <button onClick={() => setEnabled(!enabled)}
              className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? "bg-pos" : "bg-muted/30"}`}>
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? "translate-x-4" : ""}`} />
            </button>
          </label>

          <Field label="Interval">
            <select value={intervalVal} onChange={(e) => setIntervalVal(Number(e.target.value))}
              className="w-full bg-bg2 border border-border/50 rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-accent/60">
              {INTERVALS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
            {intervalVal === -1 && (
              <input type="number" min={1} max={1440} value={customInterval}
                onChange={(e) => setCustomInterval(Number(e.target.value))}
                className="mt-2 w-full bg-bg2 border border-border/50 rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-accent/60"
                placeholder="Minutes" />
            )}
          </Field>

          <Field label="Trading hours window (local)">
            <div className="flex items-center gap-2">
              <input type="number" min={0} max={23} value={hoursStart} onChange={(e) => setHoursStart(Number(e.target.value))}
                className="w-20 bg-bg2 border border-border/50 rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-accent/60" />
              <span className="text-muted text-sm">:00 to</span>
              <input type="number" min={0} max={23} value={hoursEnd} onChange={(e) => setHoursEnd(Number(e.target.value))}
                className="w-20 bg-bg2 border border-border/50 rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-accent/60" />
              <span className="text-muted text-sm">:00</span>
            </div>
            <p className="text-[0.72rem] text-muted mt-1">Runs outside this window are skipped.</p>
          </Field>

          <Field label="Watchlist limit">
            <input type="number" min={1} max={200} value={watchlistLimit} onChange={(e) => setWatchlistLimit(Number(e.target.value))}
              className="w-24 bg-bg2 border border-border/50 rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-accent/60" />
          </Field>

          <label className="flex items-center gap-2.5 mb-5 cursor-pointer">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)}
              className="w-4 h-4 accent-accent" />
            <span className="text-sm">Dry-run mode (no real orders)</span>
          </label>

          <button onClick={handleSave} disabled={saveState === "saving"}
            className="w-full text-sm font-semibold px-4 py-2 rounded-lg border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-40 transition-colors">
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : "Save settings"}
          </button>
        </section>

        {/* Live log */}
        <section className="bg-card rounded-xl border border-border/50 p-4 flex flex-col min-h-0">
          <h2 className="text-[0.7rem] font-bold uppercase tracking-widest text-muted mb-3">Live log</h2>
          <div ref={logRef} className="flex-1 overflow-y-auto font-mono text-xs flex flex-col gap-0.5 bg-bg2 rounded-lg border border-border/40 p-3 min-h-0" style={{ minHeight: 280 }}>
            {logs.length === 0 ? (
              <span className="text-muted italic">No activity yet — run the bot or wait for the next scheduled run.</span>
            ) : logs.map((line, i) => (
              <div key={i} className="flex gap-2 items-baseline">
                <span className="text-muted w-20 flex-shrink-0 text-[0.68rem]">
                  {new Date(line.createdAt).toLocaleTimeString("en-US", { hour12: false })}
                </span>
                <span className={`w-10 flex-shrink-0 font-bold text-[0.67rem] ${TAG_COLORS[line.tag] ?? "text-muted"}`}>{line.tag}</span>
                <span className="text-text break-all">{line.message}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className="mt-auto pt-3 border-t border-border/30 text-[0.78rem] text-muted">
        Log auto-refreshes every 3s
      </footer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="block text-[0.72rem] font-bold uppercase tracking-widest text-muted mb-1.5">{label}</label>
      {children}
    </div>
  );
}
