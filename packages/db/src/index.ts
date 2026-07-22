// Singleton Prisma client shared by apps/api. Avoids exhausting DB connections in dev
// (Next.js/Nest hot-reload can otherwise spawn a new PrismaClient per reload).
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __wealthosPrisma: PrismaClient | undefined;
}

export const prisma = global.__wealthosPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__wealthosPrisma = prisma;
}

export * from "@prisma/client";
