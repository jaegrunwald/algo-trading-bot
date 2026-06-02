import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { prisma } from "../../lib/prisma";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { existsSync } from "fs";

// ── Singleton bot process state (lives in Node.js server memory) ──────────────
const LOG_MAX = 300;
let botProcess: ChildProcess | null = null;
let botRunning = false;
let lastRunAt: string | null = null;
let lastRunEndAt: string | null = null;
let nextRunAt: string | null = null;
const logBuffer: { tag: string; message: string; createdAt: Date }[] = [];
const sseClients = new Set<(line: string) => void>();

function pushLog(tag: string, msg: string) {
  const entry = { tag, message: msg, createdAt: new Date() };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  const json = JSON.stringify(entry);
  sseClients.forEach((send) => send(json));
  // Persist to DB asynchronously
  prisma.botLogEntry.create({ data: entry }).catch(() => {});
}

function pythonBin() {
  const root = path.resolve(process.cwd(), "..");
  for (const p of [
    path.join(root, ".venv/bin/python3"),
    path.join(root, ".venv/bin/python"),
  ]) {
    if (existsSync(p)) return p;
  }
  return "python3";
}

function computeNextRunAt(cfg: { enabled: boolean; intervalMinutes: number }) {
  if (!cfg.enabled || cfg.intervalMinutes <= 0) { nextRunAt = null; return; }
  const base = lastRunAt ? new Date(lastRunAt) : new Date();
  nextRunAt = new Date(base.getTime() + cfg.intervalMinutes * 60_000).toISOString();
}

async function getOrCreateConfig() {
  return prisma.schedulerConfig.upsert({
    where: { id: 1 },
    update: {},
    create: {},
  });
}

function spawnBot(cfg: { dryRun: boolean; watchlistLimit: number }, manual: boolean) {
  if (botRunning) return false;
  const py = pythonBin();
  const mainPath = path.resolve(process.cwd(), "..", "main.py");
  const args = [mainPath];
  if (cfg.dryRun) args.push("--dry-run");
  args.push("--watchlist-limit", String(cfg.watchlistLimit));

  const proc = spawn(py, args, { cwd: path.resolve(process.cwd(), ".."), env: process.env });
  botProcess = proc;
  botRunning = true;
  lastRunAt = new Date().toISOString();
  pushLog("START", `Bot started${manual ? " (manual)" : " (scheduled)"}${cfg.dryRun ? " [dry-run]" : ""}`);

  proc.stdout?.on("data", (chunk: Buffer) =>
    chunk.toString().split("\n").filter(Boolean).forEach((l) => pushLog("INFO", l))
  );
  proc.stderr?.on("data", (chunk: Buffer) =>
    chunk.toString().split("\n").filter(Boolean).forEach((l) => pushLog("LOG", l))
  );
  proc.on("close", async (code) => {
    botRunning = false;
    botProcess = null;
    lastRunEndAt = new Date().toISOString();
    pushLog("DONE", `Bot exited (code ${code ?? "—"})`);
    const cfg = await getOrCreateConfig();
    computeNextRunAt(cfg);
  });
  proc.on("error", (e) => {
    pushLog("ERR", `Process error: ${e.message}`);
    botRunning = false;
    botProcess = null;
  });
  return true;
}

// Scheduler tick — runs every 30s
setInterval(async () => {
  if (botRunning || !nextRunAt) return;
  const cfg = await getOrCreateConfig();
  if (!cfg.enabled) return;
  if (new Date() < new Date(nextRunAt)) return;
  const h = new Date().getHours();
  if (h < cfg.hoursStart || h > cfg.hoursEnd) {
    pushLog("SKIP", `Outside hours (${cfg.hoursStart}:00–${cfg.hoursEnd}:00); advancing schedule`);
    lastRunAt = new Date().toISOString();
    computeNextRunAt(cfg);
    return;
  }
  spawnBot(cfg, false);
}, 30_000);

// ── tRPC router ───────────────────────────────────────────────────────────────
export const schedulerRouter = router({
  get: publicProcedure.query(async () => {
    const config = await getOrCreateConfig();
    return {
      config,
      running: botRunning,
      lastRunAt,
      lastRunEndAt,
      nextRunAt,
      recentLogs: logBuffer.slice(-100),
    };
  }),

  setConfig: publicProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        intervalMinutes: z.number().min(1).max(1440),
        hoursStart: z.number().min(0).max(23),
        hoursEnd: z.number().min(0).max(23),
        dryRun: z.boolean(),
        watchlistLimit: z.number().min(1).max(200),
      })
    )
    .mutation(async ({ input }) => {
      const config = await prisma.schedulerConfig.upsert({
        where: { id: 1 },
        update: input,
        create: { id: 1, ...input },
      });
      if (config.enabled) computeNextRunAt(config);
      else nextRunAt = null;
      return { config, nextRunAt };
    }),

  runNow: publicProcedure.mutation(async () => {
    if (botRunning) return { ok: false, reason: "already_running" as const };
    const cfg = await getOrCreateConfig();
    const ok = spawnBot(cfg, true);
    return { ok };
  }),

  stop: publicProcedure.mutation(() => {
    if (!botProcess) return { ok: false };
    botProcess.kill("SIGTERM");
    pushLog("STOP", "Bot stopped by user");
    return { ok: true };
  }),

  // Returns current in-memory log buffer (SSE is handled via a separate route)
  logs: publicProcedure.query(() => logBuffer.slice(-100)),
});

// Export for SSE route
export { sseClients, logBuffer };
