import { Prisma } from "@wealthos/db";

// Takes a Postgres transaction-scoped advisory lock keyed by an arbitrary string, so two
// concurrent requests that read-then-write the same financial entity (e.g. two repayments
// against one receivable) are serialized instead of both passing the same balance check.
// The lock is released automatically when the surrounding transaction commits or rolls back.
export async function lockKey(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
