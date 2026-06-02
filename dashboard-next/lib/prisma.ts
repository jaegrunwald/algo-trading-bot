import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrisma() {
  // DATABASE_URL can be "file:./dev.db" or "file:/data/trading.db"
  // PrismaBetterSqlite3 wants the raw path, not the file: URI prefix
  const raw = process.env.DATABASE_URL ?? "file:./dev.db";
  const url = raw.startsWith("file:") ? raw.slice(5) : raw;
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter } as never);
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
