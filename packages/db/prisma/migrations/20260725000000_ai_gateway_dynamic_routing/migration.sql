-- AI Gateway: dynamic routing, semantic cache, exact token accounting, grounding/
-- hallucination detection. Adds observability columns to the existing
-- AiInteractionLog table only — no other tables touched, no data backfill needed
-- (all new columns are nullable or have safe defaults so existing rows remain valid).

ALTER TABLE "AiInteractionLog"
  ADD COLUMN "cacheType" TEXT,
  ADD COLUMN "promptTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "completionTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "estimatedCostUsd" DECIMAL(12,8),
  ADD COLUMN "routingReason" TEXT,
  ADD COLUMN "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "groundingScore" DECIMAL(4,3),
  ADD COLUMN "hallucinationRisk" TEXT NOT NULL DEFAULT 'unmeasured';

CREATE INDEX "AiInteractionLog_model_taskType_createdAt_idx" ON "AiInteractionLog"("model", "taskType", "createdAt");
