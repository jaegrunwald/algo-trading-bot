import { router, publicProcedure } from "../trpc";

function ratingEngineUrl() {
  return (process.env.RATING_ENGINE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
}

export const modelRouter = router({
  get: publicProcedure.query(async () => {
    const url = `${ratingEngineUrl()}/api/model`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error("model unavailable");
      const body = await r.json();
      return {
        trainedAt: body.trained_at as string | null,
        featurePipeline: body.feature_pipeline as string | null,
        classifier: body.classifier as string | null,
        period: body.period as string | null,
        inference: body.inference as Record<string, unknown> | null,
      };
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }),
});
