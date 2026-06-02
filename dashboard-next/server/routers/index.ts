import { router } from "../trpc";
import { statsRouter } from "./stats";
import { positionsRouter } from "./positions";
import { schedulerRouter } from "./scheduler";
import { ratingsRouter } from "./ratings";
import { modelRouter } from "./model";

export const appRouter = router({
  stats: statsRouter,
  positions: positionsRouter,
  scheduler: schedulerRouter,
  ratings: ratingsRouter,
  model: modelRouter,
});

export type AppRouter = typeof appRouter;
