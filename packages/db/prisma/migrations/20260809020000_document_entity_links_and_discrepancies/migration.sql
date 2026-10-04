-- WealthOS AI — financial-core upgrade, phase 5: document entity linking, extraction
-- metadata, document/database discrepancies, and a FINANCIAL_FACT RAG source type.
-- Purely additive: every new Document column is nullable, so existing documents are unlinked
-- and otherwise unchanged. Hand-derived like the earlier migrations; confirm with
-- `prisma migrate dev` against a real database before production use.

-- AlterEnum (adding a value is non-destructive; it is not used elsewhere in this migration)
ALTER TYPE "AiSourceType" ADD VALUE 'FINANCIAL_FACT';

CREATE TYPE "DocumentEntityType" AS ENUM ('POLICY', 'INVESTMENT', 'LOAN', 'PROPERTY', 'INCOME', 'TAX', 'BUSINESS');
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'KEPT_DATABASE', 'DISMISSED', 'RESOLVED');

ALTER TABLE "Document"
    ADD COLUMN "entityType" "DocumentEntityType",
    ADD COLUMN "entityId" TEXT,
    ADD COLUMN "documentType" TEXT,
    ADD COLUMN "extractionMetadata" JSONB,
    ADD COLUMN "extractionConfidence" DECIMAL(4,3);

CREATE INDEX "Document_userId_entityType_entityId_idx" ON "Document"("userId", "entityType", "entityId");

CREATE TABLE "DocumentDiscrepancy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "entityType" "DocumentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "documentValue" TEXT NOT NULL,
    "databaseValue" TEXT NOT NULL,
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "DocumentDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentDiscrepancy_documentId_entityType_entityId_field_key"
    ON "DocumentDiscrepancy"("documentId", "entityType", "entityId", "field");
CREATE INDEX "DocumentDiscrepancy_userId_status_idx" ON "DocumentDiscrepancy"("userId", "status");

ALTER TABLE "DocumentDiscrepancy" ADD CONSTRAINT "DocumentDiscrepancy_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentDiscrepancy" ADD CONSTRAINT "DocumentDiscrepancy_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
