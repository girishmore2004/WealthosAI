-- WealthOS AI — Phase 15 migration.
--
-- Same provenance note as every prior migration: hand-derived from schema.prisma
-- without network access to the Prisma engine binary. Run `npx prisma migrate dev`
-- once against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: adds probabilistic planning to Scenario Studio.
--   1. ScenarioStudioRun gains a nullable `monteCarloSummary` column — the fast,
--      reduced-fidelity Monte Carlo preview attached to build()'s ranked winner.
--   2. ScenarioMonteCarloRun — an audit log of POST /scenario-studio/simulate calls.
--   3. ScenarioOptimizationRun — an audit log of POST /scenario-studio/optimize calls.
-- Does not touch SavedScenario, ScenarioType, or any other existing table. Both new
-- endpoints call the existing SimulatorService (via MonteCarloSimulationService) to
-- gather the real baseline and only log their own additional layer here — same
-- pattern the original ScenarioStudioRun migration already established.

ALTER TABLE "ScenarioStudioRun" ADD COLUMN "monteCarloSummary" JSONB;

CREATE TABLE "ScenarioMonteCarloRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scenarioType" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "config" JSONB NOT NULL,
    "terminalPercentiles" JSONB NOT NULL,
    "probabilityOfNetWorthDecline" DECIMAL(6,5) NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "coefficientOfVariation" DECIMAL(10,5) NOT NULL,
    "explanation" TEXT NOT NULL,
    "explanationConfidence" DECIMAL(4,3) NOT NULL,
    "verificationPassed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioMonteCarloRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScenarioMonteCarloRun_userId_createdAt_idx" ON "ScenarioMonteCarloRun"("userId", "createdAt");

ALTER TABLE "ScenarioMonteCarloRun" ADD CONSTRAINT "ScenarioMonteCarloRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ScenarioOptimizationRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scenarioType" TEXT NOT NULL,
    "constraints" JSONB NOT NULL,
    "recommendedParams" JSONB NOT NULL,
    "searchRange" JSONB NOT NULL,
    "candidatesEvaluated" INTEGER NOT NULL,
    "feasible" BOOLEAN NOT NULL,
    "violatedConstraints" TEXT[],
    "riskAdjustedScore" DECIMAL(16,2) NOT NULL,
    "explanation" TEXT NOT NULL,
    "explanationConfidence" DECIMAL(4,3) NOT NULL,
    "verificationPassed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioOptimizationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScenarioOptimizationRun_userId_createdAt_idx" ON "ScenarioOptimizationRun"("userId", "createdAt");

ALTER TABLE "ScenarioOptimizationRun" ADD CONSTRAINT "ScenarioOptimizationRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
