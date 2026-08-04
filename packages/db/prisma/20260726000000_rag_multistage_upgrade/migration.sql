-- WealthOS AI — RAG Search multi-stage upgrade migration.
--
-- Same provenance note as every prior migration: hand-derived from schema.prisma
-- without network access to the Prisma engine binary. Run `npx prisma migrate dev`
-- once against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: adds storage for RAG Search's upgraded pipeline — parent-child hierarchical
-- chunking (AiEmbeddingChunk.parentText), embedding-version migration tracking
-- (AiEmbeddingChunk.embeddingModelVersion), Layer 3 document-relationship traversal
-- edges (AiEmbeddingChunk.relatedSourceIds), incremental/delta indexing state
-- (new AiSourceIndexState table), and richer AiSearchLog observability (queryType,
-- complexity, groundingScore, hallucinationRisk, citationConfidences). No existing
-- RAG or non-RAG tables are dropped or renamed — every change here is additive.

-- ============================================================================
-- AiEmbeddingChunk — new columns
-- ============================================================================

ALTER TABLE "AiEmbeddingChunk"
  ADD COLUMN "parentText" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "embeddingModelVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "relatedSourceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: existing rows have no real parentText yet (the column above defaulted
-- them to ''), so fall back to the chunk's own text as its own "parent" until the
-- next reindex recomputes real parent sections — better than leaving grounding
-- context empty for anything not yet reindexed after this migration ships.
UPDATE "AiEmbeddingChunk" SET "parentText" = "text" WHERE "parentText" = '';

CREATE INDEX "AiEmbeddingChunk_userId_sourceId_idx" ON "AiEmbeddingChunk"("userId", "sourceId");
CREATE INDEX "AiEmbeddingChunk_userId_embeddingModelVersion_idx" ON "AiEmbeddingChunk"("userId", "embeddingModelVersion");

-- ============================================================================
-- AiSourceIndexState — new table (incremental/delta indexing state)
-- ============================================================================

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

CREATE UNIQUE INDEX "AiSourceIndexState_userId_sourceType_sourceId_key"
    ON "AiSourceIndexState"("userId", "sourceType", "sourceId");
CREATE INDEX "AiSourceIndexState_userId_idx" ON "AiSourceIndexState"("userId");

ALTER TABLE "AiSourceIndexState" ADD CONSTRAINT "AiSourceIndexState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: this migration intentionally does NOT backfill AiSourceIndexState from
-- existing AiEmbeddingChunk rows. The first reindex a user runs after this migration
-- ships will find no AiSourceIndexState rows for them, treat every one of their
-- sources as "dirty", and do one full rebuild — functionally identical to today's
-- pre-migration full-rebuild behavior for that one call, after which incremental
-- indexing takes over. This avoids inferring a synthetic contentHash for pre-existing
-- chunks that would need to somehow already match a hashing scheme that didn't exist
-- when they were written.

-- ============================================================================
-- AiSearchLog — new columns
-- ============================================================================

ALTER TABLE "AiSearchLog"
  ADD COLUMN "queryType" TEXT,
  ADD COLUMN "complexity" TEXT,
  ADD COLUMN "groundingScore" DECIMAL(4,3),
  ADD COLUMN "hallucinationRisk" TEXT,
  ADD COLUMN "citationConfidences" JSONB;
