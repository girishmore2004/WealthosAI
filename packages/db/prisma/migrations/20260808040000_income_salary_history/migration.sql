-- WealthOS AI — effective-dated Income (salary) history (audit item #4).
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: audit item #4 — "Income has no effective-dated salary history... a raise
-- is a manual edit to the existing row's amount, with no historical record of what
-- the salary was before." Adds IncomeHistory, populated automatically going forward
-- by IncomeService.update() whenever a row's amount changes. Purely additive — no
-- existing table or column is altered, and no historical data is backfilled or
-- reinterpreted (per the master preservation rules: "Do not silently migrate or
-- reinterpret existing historical data").

CREATE TABLE "IncomeHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "incomeId" TEXT NOT NULL,
    "previousAmount" DECIMAL(14,2) NOT NULL,
    "newAmount" DECIMAL(14,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomeHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IncomeHistory_incomeId_effectiveFrom_idx" ON "IncomeHistory"("incomeId", "effectiveFrom");
CREATE INDEX "IncomeHistory_userId_idx" ON "IncomeHistory"("userId");

ALTER TABLE "IncomeHistory"
    ADD CONSTRAINT "IncomeHistory_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IncomeHistory"
    ADD CONSTRAINT "IncomeHistory_incomeId_fkey"
    FOREIGN KEY ("incomeId") REFERENCES "Income"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
