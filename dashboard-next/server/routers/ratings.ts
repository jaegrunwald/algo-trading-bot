import { router, publicProcedure } from "../trpc";

function ratingEngineUrl() {
  return (process.env.RATING_ENGINE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
}

export const ratingsRouter = router({
  list: publicProcedure.query(async () => {
    const url = `${ratingEngineUrl()}/api/ratings?period=2y&details=0`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error("ratings unavailable");
      const body = await r.json();
      return {
        period: body.period as string,
        summary: body.summary as { ok: number; errors: number },
        data: (body.data ?? []) as { ticker: string; score: number; rating: string }[],
        errors: (body.errors ?? []) as { ticker: string; error: string }[],
      };
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }),

  health: publicProcedure.query(async () => {
    const url = `${ratingEngineUrl()}/health`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      const body = await r.json();
      return { ok: r.ok && body.status === "ok" };
    } catch {
      clearTimeout(t);
      return { ok: false };
    }
  }),
});
