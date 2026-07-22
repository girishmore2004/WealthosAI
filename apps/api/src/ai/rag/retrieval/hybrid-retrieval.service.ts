import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { AiSourceType } from "@wealthos/db";
import { EmbeddingService, cosineSimilarity } from "../embedding/embedding.service";
import { KeywordScorerService } from "./keyword-scorer.service";
import { MAX_SOURCE_PRIORITY, MIN_EVIDENCE_SIMILARITY, RECENCY_HALF_LIFE_DAYS, RETRIEVAL_WEIGHTS, TOP_K_CANDIDATES } from "../rag.constants";

export interface SearchFilters {
  sourceTypes?: AiSourceType[];
  dateFrom?: Date;
  dateTo?: Date;
}

export interface ScoredChunk {
  id: string;
  sourceType: AiSourceType;
  sourceId: string;
  text: string;
  metadata: Record<string, unknown>;
  sourceCreatedAt: Date;
  semanticScore: number;
  keywordScore: number;
  recencyScore: number;
  priorityScore: number;
  combinedScore: number;
}

// Application-level retrieval, not a vector-DB query — see the Phase 11 migration's
// comment for why (no pgvector extension in this environment's Postgres image).
// Candidates are always scoped to one user's own AiEmbeddingChunk rows first (a plain
// indexed WHERE userId = ... query), then scored entirely in Node. That ordering
// matters for correctness as much as performance: this must never compute similarity
// against another user's chunks, full stop, regardless of how good a match the text
// might be — this is the same "own data only" boundary the deterministic Coach
// already enforces.
@Injectable()
export class HybridRetrievalService {
  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
    private keywordScorer: KeywordScorerService,
  ) {}

  async search(userId: string, query: string, filters: SearchFilters = {}): Promise<ScoredChunk[]> {
    const candidates = await this.prisma.client.aiEmbeddingChunk.findMany({
      where: {
        userId,
        ...(filters.sourceTypes?.length ? { sourceType: { in: filters.sourceTypes } } : {}),
        ...(filters.dateFrom || filters.dateTo
          ? { sourceCreatedAt: { gte: filters.dateFrom, lte: filters.dateTo } }
          : {}),
      },
    });

    if (candidates.length === 0) return [];

    const queryEmbedding = await this.embedding.embed(query);
    const semanticScores = candidates.map((c) => cosineSimilarity(queryEmbedding, c.embedding));
    const keywordScoresRaw = this.keywordScorer.score(
      query,
      candidates.map((c) => c.text),
    );
    const keywordScores = normalize(keywordScoresRaw);

    const now = Date.now();
    const decayRate = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000);

    const scored: ScoredChunk[] = candidates.map((chunk, i) => {
      const ageMs = Math.max(0, now - chunk.sourceCreatedAt.getTime());
      const recencyScore = Math.exp(-decayRate * ageMs);
      const priorityScore = chunk.sourcePriority / MAX_SOURCE_PRIORITY;
      const semanticScore = Math.max(0, semanticScores[i]);
      const keywordScore = keywordScores[i];

      const combinedScore =
        semanticScore * RETRIEVAL_WEIGHTS.semantic +
        keywordScore * RETRIEVAL_WEIGHTS.keyword +
        recencyScore * RETRIEVAL_WEIGHTS.recency +
        priorityScore * RETRIEVAL_WEIGHTS.priority;

      return {
        id: chunk.id,
        sourceType: chunk.sourceType,
        sourceId: chunk.sourceId,
        text: chunk.text,
        metadata: chunk.metadata as Record<string, unknown>,
        sourceCreatedAt: chunk.sourceCreatedAt,
        semanticScore,
        keywordScore,
        recencyScore,
        priorityScore,
        combinedScore,
      };
    });

    return scored.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, TOP_K_CANDIDATES);
  }

  /** Whether any candidate is actually similar enough to the query to count as real
   * evidence — see rag.constants.ts#MIN_EVIDENCE_SIMILARITY. Used by RagService to
   * decide whether to skip generation entirely rather than answer from weak matches. */
  hasEvidence(scoredChunks: ScoredChunk[]): boolean {
    return scoredChunks.some((c) => c.semanticScore >= MIN_EVIDENCE_SIMILARITY);
  }
}

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return values.map(() => (max === 0 ? 0 : 1));
  return values.map((v) => (v - min) / (max - min));
}
