-- WealthOS AI — Document <-> Copilot Ingestion bridge (audit item #6).
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: audit item #6 — "Documents and Copilot Ingestion are separate pipelines...
-- a Document categorized SALARY_SLIP/INSURANCE_POLICY never runs through Copilot
-- Ingestion's extraction... the two pipelines are architecturally parallel, not
-- integrated." This migration adds the schema pieces for the bank-statement half of
-- that bridge (the piece with an existing, ready-to-reuse parser — see
-- copilot-ingestion.service.ts's new ingestFromDocumentText()):
--   1. DocumentCategory.BANK_STATEMENT — no existing category represented an actual
--      bank statement upload.
--   2. IngestionSourceType.DOCUMENT_OCR — distinguishes an automatically-bridged
--      batch from a directly-uploaded OCR_IMAGE batch.
--   3. IngestionBatch.sourceDocumentId — nullable, informational trace back to the
--      originating Document.
-- Fully additive: no existing enum value, column, or table is altered or removed.
--
-- NOTE: PostgreSQL requires ALTER TYPE ... ADD VALUE to run outside an explicit
-- transaction block prior to PG 12; on PG 12+ (Prisma's supported baseline) this is
-- safe to run standalone, which is how Prisma's migration runner executes each
-- migration file already (same note as the NEW_LOAN scenario-type migration earlier
-- in this project).

ALTER TYPE "DocumentCategory" ADD VALUE 'BANK_STATEMENT';
ALTER TYPE "IngestionSourceType" ADD VALUE 'DOCUMENT_OCR';

ALTER TABLE "IngestionBatch"
    ADD COLUMN "sourceDocumentId" TEXT;
