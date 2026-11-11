-- WealthOS AI — unified AI agent.
--
-- Purely additive: creates new enums and tables only. No existing table, column or row is
-- altered, renamed or dropped, so it is safe to apply to a database holding production data
-- and nothing needs backfilling. Existing coach / RAG / ingestion tables are reused as-is.
--
-- Rollback: see the "ROLLBACK" block at the bottom (run manually; it only removes what this
-- migration created, and therefore only discards agent data).

-- CreateEnum
CREATE TYPE "AgentConversationStatus" AS ENUM ('ACTIVE', 'AWAITING_APPROVAL', 'ARCHIVED');
CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');
CREATE TYPE "AgentMemoryCategory" AS ENUM ('EPISODIC', 'SEMANTIC', 'GOAL', 'PROCEDURAL');
CREATE TYPE "AgentMemorySource" AS ENUM ('USER_CONFIRMED', 'SYSTEM_VERIFIED', 'AI_INFERRED', 'CONVERSATION_CONTEXT');
CREATE TYPE "AgentMemoryVerification" AS ENUM ('UNVERIFIED', 'USER_CONFIRMED', 'SYSTEM_VERIFIED', 'SUPERSEDED', 'REJECTED');
CREATE TYPE "AgentPrivacyClass" AS ENUM ('NORMAL', 'SENSITIVE');
CREATE TYPE "AgentToolRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "AgentExecutionStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'DENIED', 'AWAITING_APPROVAL');
CREATE TYPE "AgentApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED');

-- CreateTable
CREATE TABLE "AgentConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AgentConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "AgentMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "intent" TEXT,
    "answerType" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentCheckpoint" (
    "threadId" TEXT NOT NULL,
    "checkpointNs" TEXT NOT NULL DEFAULT '',
    "checkpointId" TEXT NOT NULL,
    "parentCheckpointId" TEXT,
    "userId" TEXT NOT NULL,
    "type" TEXT,
    "checkpoint" BYTEA NOT NULL,
    "metadata" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCheckpoint_pkey" PRIMARY KEY ("threadId","checkpointNs","checkpointId")
);

CREATE TABLE "AgentCheckpointWrite" (
    "threadId" TEXT NOT NULL,
    "checkpointNs" TEXT NOT NULL DEFAULT '',
    "checkpointId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT,
    "value" BYTEA NOT NULL,
    "taskPath" TEXT NOT NULL DEFAULT '',
    "userId" TEXT NOT NULL,

    CONSTRAINT "AgentCheckpointWrite_pkey" PRIMARY KEY ("threadId","checkpointNs","checkpointId","taskId","idx")
);

CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "AgentMemoryCategory" NOT NULL,
    "subjectKey" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "payload" JSONB,
    "source" "AgentMemorySource" NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "confidence" DECIMAL(4,3) NOT NULL,
    "verification" "AgentMemoryVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "privacy" "AgentPrivacyClass" NOT NULL DEFAULT 'NORMAL',
    "embedding" DOUBLE PRECISION[],
    "embeddingVersion" INTEGER,
    "supersededById" TEXT,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "reviewAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentMemoryAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMemoryAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentMemorySnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'SYSTEM_VERIFIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMemorySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentApproval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "riskLevel" "AgentToolRisk" NOT NULL,
    "summary" TEXT NOT NULL,
    "proposedInput" JSONB NOT NULL,
    "status" "AgentApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentToolExecution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "runId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "riskLevel" "AgentToolRisk" NOT NULL,
    "inputRedacted" JSONB NOT NULL,
    "outputSummary" JSONB,
    "status" "AgentExecutionStatus" NOT NULL,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL,
    "approvalId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentToolExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentConversation_userId_lastMessageAt_idx" ON "AgentConversation"("userId", "lastMessageAt");
CREATE INDEX "AgentMessage_conversationId_createdAt_idx" ON "AgentMessage"("conversationId", "createdAt");
CREATE INDEX "AgentMessage_userId_createdAt_idx" ON "AgentMessage"("userId", "createdAt");
CREATE INDEX "AgentCheckpoint_userId_createdAt_idx" ON "AgentCheckpoint"("userId", "createdAt");
CREATE INDEX "AgentCheckpointWrite_userId_idx" ON "AgentCheckpointWrite"("userId");
CREATE UNIQUE INDEX "AgentMemory_userId_contentHash_key" ON "AgentMemory"("userId", "contentHash");
CREATE INDEX "AgentMemory_userId_category_verification_idx" ON "AgentMemory"("userId", "category", "verification");
CREATE INDEX "AgentMemory_userId_subjectKey_idx" ON "AgentMemory"("userId", "subjectKey");
CREATE INDEX "AgentMemory_expiresAt_idx" ON "AgentMemory"("expiresAt");
CREATE INDEX "AgentMemoryAudit_userId_createdAt_idx" ON "AgentMemoryAudit"("userId", "createdAt");
CREATE INDEX "AgentMemoryAudit_memoryId_idx" ON "AgentMemoryAudit"("memoryId");
CREATE UNIQUE INDEX "AgentMemorySnapshot_userId_snapshotDate_key" ON "AgentMemorySnapshot"("userId", "snapshotDate");
CREATE INDEX "AgentMemorySnapshot_userId_snapshotDate_idx" ON "AgentMemorySnapshot"("userId", "snapshotDate");
CREATE UNIQUE INDEX "AgentApproval_userId_idempotencyKey_key" ON "AgentApproval"("userId", "idempotencyKey");
CREATE INDEX "AgentApproval_userId_status_idx" ON "AgentApproval"("userId", "status");
CREATE INDEX "AgentApproval_conversationId_idx" ON "AgentApproval"("conversationId");
CREATE UNIQUE INDEX "AgentToolExecution_userId_idempotencyKey_key" ON "AgentToolExecution"("userId", "idempotencyKey");
CREATE INDEX "AgentToolExecution_userId_createdAt_idx" ON "AgentToolExecution"("userId", "createdAt");
CREATE INDEX "AgentToolExecution_conversationId_idx" ON "AgentToolExecution"("conversationId");
CREATE INDEX "AgentToolExecution_runId_idx" ON "AgentToolExecution"("runId");

-- AddForeignKey
ALTER TABLE "AgentConversation" ADD CONSTRAINT "AgentConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMemorySnapshot" ADD CONSTRAINT "AgentMemorySnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentApproval" ADD CONSTRAINT "AgentApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentToolExecution" ADD CONSTRAINT "AgentToolExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ROLLBACK (manual; discards agent data only)
-- DROP TABLE "AgentToolExecution", "AgentApproval", "AgentMemorySnapshot", "AgentMemoryAudit",
--   "AgentMemory", "AgentCheckpointWrite", "AgentCheckpoint", "AgentMessage", "AgentConversation";
-- DROP TYPE "AgentApprovalStatus", "AgentExecutionStatus", "AgentToolRisk", "AgentPrivacyClass",
--   "AgentMemoryVerification", "AgentMemorySource", "AgentMemoryCategory", "AgentMessageRole",
--   "AgentConversationStatus";
