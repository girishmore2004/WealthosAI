-- WealthOS AI — Phase 15 migration.
--
-- Same provenance note as every prior migration: hand-derived from schema.prisma
-- without network access to the Prisma engine binary. Run `npx prisma migrate dev`
-- once against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: IngestionBatch + IngestionReviewItem — a staged review queue for imported
-- statement transactions. No existing tables are touched; approving a review item
-- creates a normal Expense row via ExpensesService, the same as any manually-entered
-- expense.

CREATE TYPE "IngestionItemStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "IngestionBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "rawTextExcerpt" TEXT NOT NULL,
    "totalLines" INTEGER NOT NULL,
    "parsedCount" INTEGER NOT NULL,
    "unparsedCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestionBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IngestionBatch_userId_createdAt_idx" ON "IngestionBatch"("userId", "createdAt");

ALTER TABLE "IngestionBatch" ADD CONSTRAINT "IngestionBatch_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IngestionReviewItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawLine" TEXT NOT NULL,
    "parsedDate" TIMESTAMP(3) NOT NULL,
    "parsedAmount" DECIMAL(14,2) NOT NULL,
    "merchantRaw" TEXT NOT NULL,
    "merchantNormalized" TEXT NOT NULL,
    "suggestedCategoryId" TEXT,
    "suggestedCategoryName" TEXT,
    "categorySuggestionConfidence" DECIMAL(4,3) NOT NULL,
    "isDuplicateCandidate" BOOLEAN NOT NULL,
    "duplicateOfExpenseId" TEXT,
    "duplicateConfidence" DECIMAL(4,3) NOT NULL,
    "isRecurringCandidate" BOOLEAN NOT NULL,
    "recurringMatchMerchant" TEXT,
    "isAnomalyCandidate" BOOLEAN NOT NULL,
    "anomalyZScore" DECIMAL(6,2),
    "missingFields" TEXT[],
    "overallConfidence" DECIMAL(4,3) NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" "IngestionItemStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedExpenseId" TEXT,
    "duplicateResolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "IngestionReviewItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IngestionReviewItem_userId_status_idx" ON "IngestionReviewItem"("userId", "status");
CREATE INDEX "IngestionReviewItem_batchId_idx" ON "IngestionReviewItem"("batchId");

ALTER TABLE "IngestionReviewItem" ADD CONSTRAINT "IngestionReviewItem_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "IngestionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IngestionReviewItem" ADD CONSTRAINT "IngestionReviewItem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
