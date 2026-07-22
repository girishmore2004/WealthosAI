-- WealthOS AI — Phase 13 migration.
--
-- Same provenance note as every prior migration: hand-derived from schema.prisma
-- without network access to the Prisma engine binary. Run `npx prisma migrate dev`
-- once against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: ScenarioStudioRun — an audit log of Scenario Studio builds (parsed prompt,
-- generated variants, sensitivity sweep, ranking, explanation). Does not touch
-- SavedScenario or any other existing table; Scenario Studio calls the existing
-- SimulatorService to do its actual math and only logs its own additional layer here.

CREATE TABLE "ScenarioStudioRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "scenarioType" TEXT NOT NULL,
    "baseParams" JSONB NOT NULL,
    "targetGoalIds" TEXT[],
    "variants" JSONB NOT NULL,
    "sensitivity" JSONB NOT NULL,
    "rankedOrder" TEXT[],
    "explanation" TEXT NOT NULL,
    "explanationConfidence" DECIMAL(4,3) NOT NULL,
    "verificationPassed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioStudioRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScenarioStudioRun_userId_createdAt_idx" ON "ScenarioStudioRun"("userId", "createdAt");

ALTER TABLE "ScenarioStudioRun" ADD CONSTRAINT "ScenarioStudioRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
