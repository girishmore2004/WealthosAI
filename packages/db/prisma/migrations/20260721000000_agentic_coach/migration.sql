-- WealthOS AI — Phase 12 migration.
--
-- Same provenance note as every prior migration: hand-derived from schema.prisma
-- without network access to the Prisma engine binary. Run `npx prisma migrate dev`
-- once against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: AgenticCoachRun — records for the Phase 12 agentic coach layer (plan,
-- gathered facts, verification outcome). Does not touch CoachInteraction (Phase 5) or
-- any other existing table.

CREATE TYPE "CoachPath" AS ENUM ('DETERMINISTIC', 'ADVANCED');

CREATE TABLE "AgenticCoachRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "path" "CoachPath" NOT NULL,
    "matchedIntent" TEXT,
    "advancedIntent" TEXT,
    "plan" TEXT[],
    "facts" JSONB NOT NULL,
    "citedSources" TEXT[],
    "answer" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "verificationPassed" BOOLEAN NOT NULL,
    "staleAdviceNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgenticCoachRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgenticCoachRun_userId_createdAt_idx" ON "AgenticCoachRun"("userId", "createdAt");
CREATE INDEX "AgenticCoachRun_userId_matchedIntent_idx" ON "AgenticCoachRun"("userId", "matchedIntent");
CREATE INDEX "AgenticCoachRun_userId_advancedIntent_idx" ON "AgenticCoachRun"("userId", "advancedIntent");

ALTER TABLE "AgenticCoachRun" ADD CONSTRAINT "AgenticCoachRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
