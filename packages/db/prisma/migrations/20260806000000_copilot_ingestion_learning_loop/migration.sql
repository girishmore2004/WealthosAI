-- WealthOS AI — Copilot Ingestion: learning feedback loop, OCR ingestion, reconciliation.
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: extends the existing Copilot Ingestion tables with (a) OCR source tracking
-- on IngestionBatch, (b) suggestion-source/active-learning/reconciliation fields on
-- IngestionReviewItem, and (c) three new tables for the merchant memory learning loop
-- and its ranking model. No existing Copilot Ingestion rows are touched — every new
-- column on the two existing tables has a default, so this is a purely additive,
-- backward-compatible migration.

CREATE TYPE "IngestionSourceType" AS ENUM ('TEXT', 'OCR_IMAGE');
CREATE TYPE "TransactionKind" AS ENUM ('EXPENSE', 'LOAN_EMI', 'INVESTMENT_CONTRIBUTION');

ALTER TABLE "IngestionBatch"
    ADD COLUMN "ingestionSource" "IngestionSourceType" NOT NULL DEFAULT 'TEXT',
    ADD COLUMN "ocrExtractionConfidence" DECIMAL(4,3);

ALTER TABLE "IngestionReviewItem"
    ADD COLUMN "suggestionSource" TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN "merchantMemorySampleSize" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "transactionKind" "TransactionKind" NOT NULL DEFAULT 'EXPENSE',
    ADD COLUMN "reconciliationNote" TEXT,
    ADD COLUMN "needsActiveLearningReview" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "IngestionReviewItem_userId_needsActiveLearningReview_idx" ON "IngestionReviewItem"("userId", "needsActiveLearningReview");

CREATE TABLE "MerchantCategoryMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantNormalized" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "overrideCount" INTEGER NOT NULL DEFAULT 0,
    "embedding" DOUBLE PRECISION[],
    "lastAcceptedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantCategoryMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantCategoryMemory_userId_merchantNormalized_key" ON "MerchantCategoryMemory"("userId", "merchantNormalized");
CREATE INDEX "MerchantCategoryMemory_userId_idx" ON "MerchantCategoryMemory"("userId");

ALTER TABLE "MerchantCategoryMemory" ADD CONSTRAINT "MerchantCategoryMemory_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MerchantCategoryGlobalStat" (
    "id" TEXT NOT NULL,
    "merchantNormalized" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantCategoryGlobalStat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MerchantCategoryGlobalStat_merchantNormalized_categoryName_key" ON "MerchantCategoryGlobalStat"("merchantNormalized", "categoryName");
CREATE INDEX "MerchantCategoryGlobalStat_merchantNormalized_idx" ON "MerchantCategoryGlobalStat"("merchantNormalized");

CREATE TABLE "SuggestionRankingProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weightMemory" DECIMAL(4,3) NOT NULL DEFAULT 0.5,
    "weightAi" DECIMAL(4,3) NOT NULL DEFAULT 0.4,
    "weightGlobal" DECIMAL(4,3) NOT NULL DEFAULT 0.1,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuggestionRankingProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SuggestionRankingProfile_userId_key" ON "SuggestionRankingProfile"("userId");

ALTER TABLE "SuggestionRankingProfile" ADD CONSTRAINT "SuggestionRankingProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
