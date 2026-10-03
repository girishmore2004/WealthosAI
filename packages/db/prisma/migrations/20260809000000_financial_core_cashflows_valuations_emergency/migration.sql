-- WealthOS AI — financial-core upgrade, phase 1 (additive only).
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without access to the Prisma engine. Run `npx prisma migrate dev`
-- (or `migrate diff`) against a real database to confirm before production use.
--
-- Adds:
--   1. Expense.sourceType / sourceId / sourceReference + a unique idempotency index
--      (NULLs are distinct in Postgres, so every existing row is unaffected).
--   2. InvestmentCashflow  (dated contributions/withdrawals/etc.; XIRR-ready).
--   3. InvestmentValuation (dated current-value history).
--   4. EmergencyFundEntry  (reserved-cash ledger — an allocation is NOT an expense).
--
-- No existing column, table, enum value, or row is altered, moved, or deleted.

ALTER TABLE "Expense"
    ADD COLUMN "sourceType" TEXT,
    ADD COLUMN "sourceId" TEXT,
    ADD COLUMN "sourceReference" TEXT;

CREATE UNIQUE INDEX "Expense_source_idempotency_key"
    ON "Expense"("userId", "sourceType", "sourceId", "sourceReference");

CREATE TYPE "InvestmentCashflowType" AS ENUM (
    'CONTRIBUTION', 'WITHDRAWAL', 'SALE', 'DIVIDEND', 'FEE',
    'EMPLOYER_CONTRIBUTION', 'INTEREST', 'TRANSFER_IN', 'TRANSFER_OUT'
);

CREATE TYPE "EmergencyFundEntryType" AS ENUM (
    'ALLOCATE', 'RELEASE', 'WITHDRAWAL', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT'
);

CREATE TABLE "InvestmentCashflow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "investmentId" TEXT NOT NULL,
    "type" "InvestmentCashflowType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "periodKey" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceExpenseId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvestmentCashflow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvestmentCashflow_idempotency_key" ON "InvestmentCashflow"("investmentId", "type", "periodKey");
CREATE UNIQUE INDEX "InvestmentCashflow_sourceExpenseId_key" ON "InvestmentCashflow"("sourceExpenseId");
CREATE INDEX "InvestmentCashflow_userId_occurredAt_idx" ON "InvestmentCashflow"("userId", "occurredAt");
CREATE INDEX "InvestmentCashflow_investmentId_occurredAt_idx" ON "InvestmentCashflow"("investmentId", "occurredAt");

ALTER TABLE "InvestmentCashflow" ADD CONSTRAINT "InvestmentCashflow_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvestmentCashflow" ADD CONSTRAINT "InvestmentCashflow_investmentId_fkey"
    FOREIGN KEY ("investmentId") REFERENCES "Investment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InvestmentValuation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "investmentId" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "valuedAt" TIMESTAMP(3) NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvestmentValuation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvestmentValuation_investmentId_valuedAt_key" ON "InvestmentValuation"("investmentId", "valuedAt");
CREATE INDEX "InvestmentValuation_userId_idx" ON "InvestmentValuation"("userId");
CREATE INDEX "InvestmentValuation_investmentId_valuedAt_idx" ON "InvestmentValuation"("investmentId", "valuedAt");

ALTER TABLE "InvestmentValuation" ADD CONSTRAINT "InvestmentValuation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvestmentValuation" ADD CONSTRAINT "InvestmentValuation_investmentId_fkey"
    FOREIGN KEY ("investmentId") REFERENCES "Investment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EmergencyFundEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "EmergencyFundEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceExpenseId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmergencyFundEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmergencyFundEntry_sourceExpenseId_key" ON "EmergencyFundEntry"("sourceExpenseId");
CREATE INDEX "EmergencyFundEntry_userId_occurredAt_idx" ON "EmergencyFundEntry"("userId", "occurredAt");

ALTER TABLE "EmergencyFundEntry" ADD CONSTRAINT "EmergencyFundEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
