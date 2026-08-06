-- WealthOS AI — backfill columns/tables present in schema.prisma but missed by every
-- earlier migration.
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary (a full sweep
-- comparing every scalar field in schema.prisma against every CREATE TABLE / ALTER
-- TABLE in prisma/migrations/*/migration.sql). Run `npx prisma migrate dev` once
-- against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Every change below is purely additive — nullable columns or columns with a default,
-- and brand-new tables — so no existing row in any table is touched.

-- --------------------------------------------------------------------------------
-- Session.tokenHash — added to schema.prisma, never migrated. Nullable + unique,
-- same pattern as OtpCode.codeHash/HouseholdInvite.tokenHash elsewhere in this file.
-- --------------------------------------------------------------------------------
ALTER TABLE "Session"
    ADD COLUMN "tokenHash" TEXT;
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- --------------------------------------------------------------------------------
-- OtpCode.attempts — added to schema.prisma, never migrated.
-- --------------------------------------------------------------------------------
ALTER TABLE "OtpCode"
    ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- --------------------------------------------------------------------------------
-- AiEmbeddingChunk — three columns added to schema.prisma after the Phase 11 RAG
-- Engine migration, never migrated.
-- --------------------------------------------------------------------------------
ALTER TABLE "AiEmbeddingChunk"
    ADD COLUMN "parentText" TEXT NOT NULL DEFAULT '',
    ADD COLUMN "embeddingModelVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "relatedSourceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- --------------------------------------------------------------------------------
-- AiSearchLog — five observability columns added to schema.prisma after the
-- Phase 11 RAG Engine migration, never migrated.
-- --------------------------------------------------------------------------------
ALTER TABLE "AiSearchLog"
    ADD COLUMN "queryType" TEXT,
    ADD COLUMN "complexity" TEXT,
    ADD COLUMN "groundingScore" DECIMAL(4,3),
    ADD COLUMN "hallucinationRisk" TEXT,
    ADD COLUMN "citationConfidences" JSONB;

-- --------------------------------------------------------------------------------
-- HouseholdInvite — whole model added to schema.prisma, never migrated. Used by
-- HouseholdService for inviting members to a household.
-- --------------------------------------------------------------------------------
CREATE TYPE "HouseholdInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED');

CREATE TABLE "HouseholdInvite" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "HouseholdInviteStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "HouseholdInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HouseholdInvite_tokenHash_key" ON "HouseholdInvite"("tokenHash");
CREATE INDEX "HouseholdInvite_householdId_idx" ON "HouseholdInvite"("householdId");
CREATE INDEX "HouseholdInvite_email_idx" ON "HouseholdInvite"("email");

ALTER TABLE "HouseholdInvite" ADD CONSTRAINT "HouseholdInvite_householdId_fkey"
    FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HouseholdInvite" ADD CONSTRAINT "HouseholdInvite_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------------------------------
-- Budget — whole model added to schema.prisma, never migrated. Used by
-- UsersService/DashboardService for per-category monthly budgets.
-- --------------------------------------------------------------------------------
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "monthlyAmount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Budget_userId_categoryId_key" ON "Budget"("userId", "categoryId");

ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------------------------------
-- AiSourceIndexState — whole model added to schema.prisma, never migrated. Used by
-- RagIndexingService to track which sources have already been chunked/embedded.
-- --------------------------------------------------------------------------------
CREATE TABLE "AiSourceIndexState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" "AiSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSourceIndexState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiSourceIndexState_userId_sourceType_sourceId_key" ON "AiSourceIndexState"("userId", "sourceType", "sourceId");
CREATE INDEX "AiSourceIndexState_userId_idx" ON "AiSourceIndexState"("userId");

ALTER TABLE "AiSourceIndexState" ADD CONSTRAINT "AiSourceIndexState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
