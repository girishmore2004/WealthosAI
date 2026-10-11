import { Prisma } from "@wealthos/db";

// Takes a Postgres transaction-scoped advisory lock keyed by an arbitrary string, so two
// concurrent requests that read-then-write the same financial entity (e.g. two repayments
// against one receivable) are serialized instead of both passing the same balance check.
// The lock is released automatically when the surrounding transaction commits or rolls back.
//
// NOTE: pg_advisory_xact_lock() returns the Postgres `void` type. Prisma's $queryRaw cannot
// deserialize a `void` column and throws P2010 ("Failed to deserialize column of type 'void'"),
// which surfaced as a 500 on every write that takes this lock. $executeRaw does not read the
// result set (it only returns the affected-row count), so it takes the lock without that error.
export async function lockKey(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
