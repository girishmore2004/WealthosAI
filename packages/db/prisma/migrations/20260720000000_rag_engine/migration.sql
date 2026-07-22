-- WealthOS AI — Phase 11 migration.
--
-- Same provenance note as every prior migration: hand-derived from schema.prisma
-- without network access to the Prisma engine binary. Run `npx prisma migrate dev`
-- once against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: RAG engine storage — embedded chunks of a user's own data (documents,
-- reports, coach history, alerts, a current snapshot) and a search log for citation
-- provenance. No existing tables are touched.
--
-- NOTE: embeddings are stored as a plain double precision array column, not a
-- pgvector `vector` type — this environment's Postgres image doesn't have the
-- pgvector extension installed, and Prisma's support for it requires an
-- `Unsupported("vector(n)")` field type plus raw-SQL queries either way. Retrieval
-- does an application-level brute-force cosine similarity scoped to one user's chunks
-- at a time (see HybridRetrievalService) — genuinely fine at this data volume (at
-- most a few hundred chunks per user), and the natural upgrade path if that ever
-- stops being true is switching this column to `vector(384)` with the pgvector
-- extension enabled, not a data model change.

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE "AiSourceType" AS ENUM ('DOCUMENT', 'REPORT', 'COACH_INTERACTION', 'ALERT', 'SNAPSHOT');

-- ============================================================================
-- AiEmbeddingChunk
-- ============================================================================

CREATE TABLE "AiEmbeddingChunk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" "AiSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "tokenCount" INTEGER NOT NULL,
    "sourcePriority" INTEGER NOT NULL DEFAULT 0,
    "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiEmbeddingChunk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiEmbeddingChunk_userId_sourceType_idx" ON "AiEmbeddingChunk"("userId", "sourceType");
CREATE INDEX "AiEmbeddingChunk_userId_sourceCreatedAt_idx" ON "AiEmbeddingChunk"("userId", "sourceCreatedAt");

ALTER TABLE "AiEmbeddingChunk" ADD CONSTRAINT "AiEmbeddingChunk_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- AiSearchLog
-- ============================================================================

CREATE TABLE "AiSearchLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "rewrittenQueries" TEXT[],
    "retrievedChunkIds" TEXT[],
    "citedChunkIds" TEXT[],
    "hadEvidence" BOOLEAN NOT NULL,
    "retrievalConfidence" DECIMAL(4,3) NOT NULL,
    "answerConfidence" DECIMAL(4,3),
    "answer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSearchLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiSearchLog_userId_createdAt_idx" ON "AiSearchLog"("userId", "createdAt");

ALTER TABLE "AiSearchLog" ADD CONSTRAINT "AiSearchLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
