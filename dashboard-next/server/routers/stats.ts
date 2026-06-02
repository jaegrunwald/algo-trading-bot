import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { prisma } from "../../lib/prisma";

export const statsRouter = router({
  list: publicProcedure.query(async () => {
    const rows = await prisma.portfolioStat.findMany({
      orderBy: { timestampUtc: "asc" },
      take: 500,
    });
    return rows;
  }),

  append: publicProcedure
    .input(
      z.object({
        timestampUtc: z.string().datetime(),
        portfolioValue: z.number(),
        spyEquivalent: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const row = await prisma.portfolioStat.create({
        data: {
          timestampUtc: new Date(input.timestampUtc),
          portfolioValue: input.portfolioValue,
          spyEquivalent: input.spyEquivalent,
        },
      });
      return row;
    }),
});
