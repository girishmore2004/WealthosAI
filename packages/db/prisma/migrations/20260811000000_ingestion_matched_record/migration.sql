-- IngestionReviewItem.matchedRecordId exists in schema.prisma (the Loan / Investment / InsurancePolicy a
-- statement line was matched to at ingest time) but no earlier migration created the column, so every
-- Prisma read of IngestionReviewItem / IngestionBatch+items failed with P2022 ("column does not exist").
-- IF NOT EXISTS keeps this safe on databases where the column was already added by hand.
ALTER TABLE "IngestionReviewItem" ADD COLUMN IF NOT EXISTS "matchedRecordId" TEXT;

-- Fast lookup of "has this document already produced an ingestion batch?" (retry idempotency).
CREATE INDEX IF NOT EXISTS "IngestionBatch_userId_sourceDocumentId_idx" ON "IngestionBatch"("userId", "sourceDocumentId");
