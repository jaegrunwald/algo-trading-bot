"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href;
  return (
    <Link
      href={href}
      className={`block px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
        active
          ? "bg-accent/15 text-text border border-accent/35"
          : "text-muted hover:text-text hover:bg-card2 border border-transparent"
      }`}
    >
      {children}
    </Link>
  );
}

function fmtCountdown(ms: number) {
  if (ms <= 0) return "00:00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function Sidebar() {
  const { data, refetch } = trpc.scheduler.get.useQuery(undefined, { refetchInterval: 5000 });
  const setConfig = trpc.scheduler.setConfig.useMutation({ onSuccess: () => refetch() });

  const [countdown, setCountdown] = useState("--:--:--");
  const nextRunAt = data?.config.enabled ? data?.nextRunAt : null;

  useEffect(() => {
    const tick = () =>
      setCountdown(nextRunAt ? fmtCountdown(new Date(nextRunAt).getTime() - Date.now()) : "--:--:--");
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextRunAt]);

  const toggleAutoRun = () => {
    if (!data) return;
    setConfig.mutate({ ...data.config, enabled: !data.config.enabled });
  };

  const running = data?.running ?? false;

  return (
    <nav className="flex flex-col gap-1 w-44 flex-shrink-0 bg-card border-r border-border/50 overflow-y-auto">
      {/* Nav sections */}
      <div className="mt-3">
        <div className="px-3 py-1 text-[0.62rem] font-bold uppercase tracking-widest text-muted opacity-55">Monitor</div>
        <NavLink href="/">Overview</NavLink>
        <NavLink href="/positions">Positions</NavLink>
      </div>
      <div className="mt-2">
        <div className="px-3 py-1 text-[0.62rem] font-bold uppercase tracking-widest text-muted opacity-55">Analyze</div>
        <NavLink href="/benchmark">Benchmark</NavLink>
        <NavLink href="/watchlist">Watchlist ML</NavLink>
        <NavLink href="/model">Model</NavLink>
      </div>
      <div className="mt-2">
        <div className="px-3 py-1 text-[0.62rem] font-bold uppercase tracking-widest text-muted opacity-55">Control</div>
        <NavLink href="/scheduler">Scheduler</NavLink>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Schedule widget */}
      <div className="border-t border-border/50 pt-2 pb-3 flex-shrink-0">
        <div className="px-3 py-1 text-[0.62rem] font-bold uppercase tracking-widest text-muted opacity-55">Scheduler</div>
        <div className="px-3 pt-1">
          <div className="font-mono text-2xl font-bold text-text tracking-wide leading-none">{countdown}</div>
          <div className="text-[0.68rem] text-muted mt-1 opacity-75">
            {running ? "bot is running" : data?.config.enabled ? "until next run" : "scheduler off"}
          </div>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm">Auto-run</span>
          <button
            onClick={toggleAutoRun}
            className={`relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none ${
              data?.config.enabled ? "bg-pos" : "bg-muted/30"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${
                data?.config.enabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
        <div className="flex items-center gap-2 px-3">
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              running ? "bg-pos shadow-[0_0_6px_var(--color-pos)] animate-pulse" : "bg-muted"
            }`}
          />
          <span className="text-[0.75rem] text-muted">{running ? "Running" : "Idle"}</span>
        </div>
      </div>
    </nav>
  );
}
