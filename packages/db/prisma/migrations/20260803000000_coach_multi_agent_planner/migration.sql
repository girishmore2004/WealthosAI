-- WealthOS AI — Phase 20 migration: Coach Multi-Agent Planner.
--
-- Same provenance note as every prior migration: hand-derived from schema.prisma
-- without network access to the Prisma engine binary. Run `npx prisma migrate dev`
-- once against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: adds persistent plans, tasks, progress tracking, financial memory, and
-- proactive nudges for the Coach feature's multi-agent planner. Extends
-- AgenticCoachRun with three new nullable/defaulted columns. Touches no other
-- feature's tables.

-- --- AgenticCoachRun extensions ------------------------------------------------------
ALTER TABLE "AgenticCoachRun" ADD COLUMN "criticFlags" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "AgenticCoachRun" ADD COLUMN "createdTaskIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "AgenticCoachRun" ADD COLUMN "planId" TEXT;

-- --- Enums ---------------------------------------------------------------------------
CREATE TYPE "CoachPlanType" AS ENUM ('DEBT_PAYOFF', 'SAVINGS_TARGET', 'RETIREMENT', 'INVESTMENT_ALLOCATION', 'CUSTOM');
CREATE TYPE "CoachPlanStatus" AS ENUM ('ACTIVE', 'AT_RISK', 'COMPLETED', 'ABANDONED');
CREATE TYPE "CoachStepStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED');
CREATE TYPE "CoachTaskStatus" AS ENUM ('OPEN', 'DONE', 'DISMISSED');
CREATE TYPE "CoachProgressSource" AS ENUM ('USER_QUERY', 'PROACTIVE_CHECK');
CREATE TYPE "CoachNudgeSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- --- CoachFinancialMemory --------------------------------------------------------------
CREATE TABLE "CoachFinancialMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "constraints" JSONB NOT NULL DEFAULT '[]',
    "preferences" JSONB NOT NULL DEFAULT '[]',
    "goalNotes" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachFinancialMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachFinancialMemory_userId_key" ON "CoachFinancialMemory"("userId");

ALTER TABLE "CoachFinancialMemory" ADD CONSTRAINT "CoachFinancialMemory_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- CoachPlan -------------------------------------------------------------------------
CREATE TABLE "CoachPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CoachPlanType" NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "linkedGoalId" TEXT,
    "linkedLoanId" TEXT,
    "targetMetricType" TEXT NOT NULL,
    "targetValue" DECIMAL(14,2) NOT NULL,
    "targetDate" TIMESTAMP(3) NOT NULL,
    "startingValue" DECIMAL(14,2) NOT NULL,
    "currentValue" DECIMAL(14,2) NOT NULL,
    "status" "CoachPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoachPlan_userId_status_idx" ON "CoachPlan"("userId", "status");

ALTER TABLE "CoachPlan" ADD CONSTRAINT "CoachPlan_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- CoachPlanStep ---------------------------------------------------------------------
CREATE TABLE "CoachPlanStep" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" "CoachStepStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachPlanStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoachPlanStep_planId_sequence_idx" ON "CoachPlanStep"("planId", "sequence");

ALTER TABLE "CoachPlanStep" ADD CONSTRAINT "CoachPlanStep_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "CoachPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- CoachTask ---------------------------------------------------------------------------
CREATE TABLE "CoachTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" "CoachTaskStatus" NOT NULL DEFAULT 'OPEN',
    "sourceRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CoachTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoachTask_userId_status_idx" ON "CoachTask"("userId", "status");
CREATE INDEX "CoachTask_planId_idx" ON "CoachTask"("planId");

ALTER TABLE "CoachTask" ADD CONSTRAINT "CoachTask_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachTask" ADD CONSTRAINT "CoachTask_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "CoachPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- CoachProgressSnapshot ---------------------------------------------------------------
CREATE TABLE "CoachProgressSnapshot" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metricValue" DECIMAL(14,2) NOT NULL,
    "onTrack" BOOLEAN NOT NULL,
    "note" TEXT NOT NULL,
    "source" "CoachProgressSource" NOT NULL,

    CONSTRAINT "CoachProgressSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoachProgressSnapshot_planId_checkedAt_idx" ON "CoachProgressSnapshot"("planId", "checkedAt");

ALTER TABLE "CoachProgressSnapshot" ADD CONSTRAINT "CoachProgressSnapshot_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "CoachPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- CoachNudge ---------------------------------------------------------------------------
CREATE TABLE "CoachNudge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "severity" "CoachNudgeSeverity" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "dismissed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachNudge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoachNudge_userId_dismissed_idx" ON "CoachNudge"("userId", "dismissed");

ALTER TABLE "CoachNudge" ADD CONSTRAINT "CoachNudge_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachNudge" ADD CONSTRAINT "CoachNudge_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "CoachPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
