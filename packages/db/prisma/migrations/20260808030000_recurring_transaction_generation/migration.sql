-- WealthOS AI — recurring Income/Expense generation (audit item #3).
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: audit item #3 — "Recurring Income and Expense records do not materialize
-- future events... nothing generates a fresh row each month." Adds:
--   1. Opt-in recurrence-generation fields on Income and Expense, all nullable/
--      defaulted so every existing row gets recurrenceActive = false ("not
--      generating," identical to today's behavior) until a user explicitly opts in.
--   2. A `recurrence` cadence column on Expense, which didn't exist before (Expense
--      previously only had the boolean `isRecurring` — no way to know HOW OFTEN).
--      Nullable, does not touch or replace `isRecurring`.
--   3. RecurringEventLog — the idempotency/audit table for generated occurrences.
--
-- This migration is purely additive: no existing column, table, or enum value is
-- altered or removed.

ALTER TABLE "Income"
    ADD COLUMN "recurrenceActive" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "recurrenceEndDate" TIMESTAMP(3),
    ADD COLUMN "nextOccurrenceAt" TIMESTAMP(3),
    ADD COLUMN "generatedFromRecurringId" TEXT;

CREATE INDEX "Income_recurrenceActive_nextOccurrenceAt_idx" ON "Income"("recurrenceActive", "nextOccurrenceAt");

ALTER TABLE "Expense"
    ADD COLUMN "recurrence" "Recurrence",
    ADD COLUMN "recurrenceActive" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "recurrenceEndDate" TIMESTAMP(3),
    ADD COLUMN "nextOccurrenceAt" TIMESTAMP(3),
    ADD COLUMN "generatedFromRecurringId" TEXT;

CREATE INDEX "Expense_recurrenceActive_nextOccurrenceAt_idx" ON "Expense"("recurrenceActive", "nextOccurrenceAt");

CREATE TABLE "RecurringEventLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurrenceDate" TIMESTAMP(3) NOT NULL,
    "generatedRecordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringEventLog_pkey" PRIMARY KEY ("id")
);

-- The actual idempotency mechanism: a retried or concurrently-run generation attempt
-- for the same (sourceType, sourceId, occurrenceDate) hits this constraint, which the
-- generator service catches and treats as "already generated, skip."
CREATE UNIQUE INDEX "RecurringEventLog_sourceType_sourceId_occurrenceDate_key"
    ON "RecurringEventLog"("sourceType", "sourceId", "occurrenceDate");

CREATE INDEX "RecurringEventLog_userId_createdAt_idx" ON "RecurringEventLog"("userId", "createdAt");

ALTER TABLE "RecurringEventLog"
    ADD CONSTRAINT "RecurringEventLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
