-- WealthOS AI — Phase 14 migration.
--
-- Same provenance note as every prior migration: hand-derived from schema.prisma
-- without network access to the Prisma engine binary. Run `npx prisma migrate dev`
-- once against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: MlInsightRun — an audit/evaluation log of ML Insights runs (headline
-- numbers per model, plus a full snapshot for history display). No existing tables
-- are touched; every model this phase adds computes over data already gathered by
-- ExpensesService/IncomeService/GoalsService/LoansService/DashboardService.

CREATE TABLE "MlInsightRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "anomalyCount" INTEGER NOT NULL,
    "cashflowStressRisk" BOOLEAN NOT NULL,
    "debtRiskScore" INTEGER NOT NULL,
    "debtRiskTier" TEXT NOT NULL,
    "driftDetected" BOOLEAN NOT NULL,
    "driftDirection" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlInsightRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MlInsightRun_userId_createdAt_idx" ON "MlInsightRun"("userId", "createdAt");

ALTER TABLE "MlInsightRun" ADD CONSTRAINT "MlInsightRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
