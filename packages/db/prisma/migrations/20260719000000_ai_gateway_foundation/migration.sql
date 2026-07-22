-- WealthOS AI — Phase 10 migration.
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: infrastructure for the real AiGateway (apps/api/src/ai/) — a prompt
-- registry, a per-call interaction log, and a background job table. No existing
-- tables are touched; this is three new tables plus three new enums.

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE "AiInteractionStatus" AS ENUM ('OK', 'MALFORMED_FALLBACK', 'ERROR');
CREATE TYPE "AiJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- ============================================================================
-- AiPromptVersion
-- ============================================================================

CREATE TABLE "AiPromptVersion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "template" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiPromptVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiPromptVersion_name_version_key" ON "AiPromptVersion"("name", "version");
CREATE INDEX "AiPromptVersion_name_isActive_idx" ON "AiPromptVersion"("name", "isActive");

-- ============================================================================
-- AiInteractionLog
-- ============================================================================

CREATE TABLE "AiInteractionLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "feature" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "promptName" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "status" "AiInteractionStatus" NOT NULL,
    "confidence" DECIMAL(4,3),
    "retries" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "redactedInput" TEXT NOT NULL,
    "rawOutput" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInteractionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiInteractionLog_userId_createdAt_idx" ON "AiInteractionLog"("userId", "createdAt");
CREATE INDEX "AiInteractionLog_feature_createdAt_idx" ON "AiInteractionLog"("feature", "createdAt");

ALTER TABLE "AiInteractionLog" ADD CONSTRAINT "AiInteractionLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- AiJob
-- ============================================================================

CREATE TABLE "AiJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "status" "AiJobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT,
    "input" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiJob_userId_idempotencyKey_key" ON "AiJob"("userId", "idempotencyKey");
CREATE INDEX "AiJob_userId_createdAt_idx" ON "AiJob"("userId", "createdAt");
CREATE INDEX "AiJob_status_idx" ON "AiJob"("status");

ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
