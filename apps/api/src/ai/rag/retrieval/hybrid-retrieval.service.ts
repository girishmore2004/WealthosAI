import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { AiSourceType } from "@wealthos/db";
import { EmbeddingService, cosineSimilarity } from "../embedding/embedding.service";
import { KeywordScorerService, tokenize } from "./keyword-scorer.service";
import {
  MAX_SOURCE_PRIORITY,
  MIN_EVIDENCE_SIMILARITY,
  MAX_RELATED_SOURCE_EXPANSIONS,
  MAX_SIBLING_EXPANSIONS,
  NEAR_DUPLICATE_JACCARD_THRESHOLD,
  QueryComplexity,
  QueryType,
  RECENCY_HALF_LIFE_DAYS,
  RETRIEVAL_WEIGHT_PROFILES,
  SIBLING_EXPANSION_RADIUS,
  adaptiveCandidateLimit,
} from "../rag.constants";

export interface SearchFilters {
  sourceTypes?: AiSourceType[];
  dateFrom?: Date;
  dateTo?: Date;
  /** Document.category values to narrow to (e.g. "INSURANCE", "LOAN_AGREEMENT") —
   * only ever applied to DOCUMENT-sourced chunks; other source types don't have a
   * category and are left untouched by this filter rather than being wrongly
   * excluded just because the concept doesn't apply to them. */
  categories?: string[];
  /** Document.tags values, OR-matched — a chunk passes if it shares at least one tag
   * with this list. Same "only applies where the concept exists" rule as categories. */
  tags?: string[];
}

export interface QueryContext {
  queryType?: QueryType;
  complexity?: QueryComplexity;
}

export type ExpansionReason = "seed" | "sibling" | "related_source";

export interface ScoredChunk {
  id: string;
  sourceType: AiSourceType;
  sourceId: string;
  chunkIndex: number;
  text: string;
  /** The larger section this chunk was extracted from at index time (see
   * ChunkerService) — used by AnswerSynthesisService to build a broader grounding
   * context than the narrow child chunk alone ("contextual chunk expansion"). */
  parentText: string;
  metadata: Record<string, unknown>;
  sourceCreatedAt: Date;
  semanticScore: number;
  keywordScore: number;
  recencyScore: number;
  priorityScore: number;
  combinedScore: number;
  /** Other sourceIds this chunk's source was linked to at index time (see
   * RagIndexingService#computeRelatedSourceIds) — Layer 3's traversal edges. Not
   * itself a score; consumed by expandWithRelationships() to decide what to pull in
   * around a seed. */
  relatedSourceIds: string[];
  /** How this chunk entered the candidate pool — a direct hybrid-search match
   * ("seed"), or Layer 3 relationship traversal off a seed ("sibling"/
   * "related_source"). Surfaced (not just used internally) so the reranker's rationale
   * and, eventually, the UI can explain *why* a given citation is present even though
   * it may not have matched the query terms/embedding directly. */
  expansionReason: ExpansionReason;
}

// Application-level retrieval, not a vector-DB query — see the Phase 11 migration's
// comment for why (no pgvector extension in this environment's Postgres image).
// Candidates are always scoped to one user's own AiEmbeddingChunk rows first (a plain
// indexed WHERE userId = ... query), then scored entirely in Node. That ordering
// matters for correctness as much as performance: this must never compute similarity
// against another user's chunks, full stop, regardless of how good a match the text
// might be — this is the same "own data only" boundary the deterministic Coach
// already enforces. Layer 3's relationship-expansion queries below carry that same
// `userId` scoping — expansion can only ever pull in more of the searching user's own
// chunks, never another user's, however related two sourceIds might look.
//
// The five-layer pipeline this class implements (Layers 1-3; Layers 4-5 are
// RerankingService/AnswerSynthesisService downstream):
//   1. Semantic retrieval — cosine similarity against the query embedding.
//   2. Keyword/BM25 retrieval — KeywordScorerService, normalized into the same [0,1]
//      range as the other signals before combining.
//   3. Knowledge-graph / document-relationship traversal — expandWithRelationships()
//      below pulls in sibling chunks (same source, adjacent chunkIndex) and
//      explicitly-related sources (same category/tags, computed at index time — see
//      RagIndexingService#computeRelatedSourceIds) around the strongest seed matches,
//      so a chunk that's the *right context* for the answer but didn't itself score
//      highest on semantic/keyword terms still has a path into the candidate pool.
@Injectable()
export class HybridRetrievalService {
  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
    private keywordScorer: KeywordScorerService,
  ) {}

  async search(
    userId: string,
    query: string,
    filters: SearchFilters = {},
    queryContext: QueryContext = {},
  ): Promise<ScoredChunk[]> {
    const queryType: QueryType = queryContext.queryType ?? "exploratory";
    const complexity: QueryComplexity = queryContext.complexity ?? "moderate";
    const weights = RETRIEVAL_WEIGHT_PROFILES[queryType];
    const candidateLimit = adaptiveCandidateLimit(complexity);

    const rawCandidates = await this.prisma.client.aiEmbeddingChunk.findMany({
      where: {
        userId,
        ...(filters.sourceTypes?.length ? { sourceType: { in: filters.sourceTypes } } : {}),
        ...(filters.dateFrom || filters.dateTo
          ? { sourceCreatedAt: { gte: filters.dateFrom, lte: filters.dateTo } }
          : {}),
      },
    });

    const filtered = rawCandidates.filter((c) => passesMetadataFilters(c.sourceType, c.metadata as Record<string, unknown>, filters));
    if (filtered.length === 0) return [];

    const queryEmbedding = await this.embedding.embed(query);
    const keywordScoresRaw = this.keywordScorer.score(
      query,
      filtered.map((c) => c.text),
    );
    const keywordScores = normalize(keywordScoresRaw);
    const now = Date.now();
    const decayRate = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000);

    const seeds: ScoredChunk[] = filtered.map((chunk, i) =>
      this.scoreChunk(chunk, cosineSimilarity(queryEmbedding, chunk.embedding), keywordScores[i], weights, now, decayRate, "seed"),
    );
    seeds.sort((a, b) => b.combinedScore - a.combinedScore);

    const seedSlice = seeds.slice(0, candidateLimit);
    const expansions = await this.expandWithRelationships(userId, seedSlice, queryEmbedding, weights, now, decayRate);

    const pool = dedupeById([...seedSlice, ...expansions]);
    const deduped = suppressNearDuplicates(pool, NEAR_DUPLICATE_JACCARD_THRESHOLD);

    return deduped.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, candidateLimit);
  }

  /** Whether any candidate is actually similar enough to the query to count as real
   * evidence — see rag.constants.ts#MIN_EVIDENCE_SIMILARITY. Used by RagService to
   * decide whether to skip generation entirely rather than answer from weak matches.
   * Deliberately checks semanticScore only, not combinedScore — a chunk that's
   * recent/high-priority but not actually similar to the query shouldn't count as
   * "evidence found" just because those other signals inflated its combined score,
   * and a Layer-3 expansion chunk (see expandWithRelationships) legitimately earns
   * its place in the candidate pool without necessarily being independently similar
   * to the query text itself. */
  hasEvidence(scoredChunks: ScoredChunk[]): boolean {
    return scoredChunks.some((c) => c.expansionReason === "seed" && c.semanticScore >= MIN_EVIDENCE_SIMILARITY);
  }

  private scoreChunk(
    chunk: {
      id: string;
      sourceType: AiSourceType;
      sourceId: string;
      chunkIndex: number;
      text: string;
      parentText: string | null;
      metadata: unknown;
      embedding: number[];
      sourcePriority: number;
      sourceCreatedAt: Date;
      relatedSourceIds: string[];
    },
    semanticScoreRaw: number,
    keywordScore: number,
    weights: (typeof RETRIEVAL_WEIGHT_PROFILES)[QueryType],
    now: number,
    decayRate: number,
    expansionReason: ExpansionReason,
  ): ScoredChunk {
    const ageMs = Math.max(0, now - chunk.sourceCreatedAt.getTime());
    const recencyScore = Math.exp(-decayRate * ageMs);
    const priorityScore = chunk.sourcePriority / MAX_SOURCE_PRIORITY;
    const semanticScore = Math.max(0, semanticScoreRaw);

    const combinedScore =
      semanticScore * weights.semantic +
      keywordScore * weights.keyword +
      recencyScore * weights.recency +
      priorityScore * weights.priority;

    return {
      id: chunk.id,
      sourceType: chunk.sourceType,
      sourceId: chunk.sourceId,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      parentText: chunk.parentText || chunk.text,
      metadata: chunk.metadata as Record<string, unknown>,
      sourceCreatedAt: chunk.sourceCreatedAt,
      semanticScore,
      keywordScore,
      recencyScore,
      priorityScore,
      combinedScore,
      relatedSourceIds: chunk.relatedSourceIds ?? [],
      expansionReason,
    };
  }

  /** Layer 3. Pulls in two kinds of additional candidates around the strongest seed
   * matches, both scoped to `userId`:
   *   - siblings: chunks from the SAME source, within SIBLING_EXPANSION_RADIUS chunk
   *     positions of a seed — the paragraphs immediately before/after a matched
   *     passage, which very often carry the qualifying detail (a date, a caveat, a
   *     total) that the matched chunk alone doesn't state.
   *   - related sources: chunks belonging to a *different* source that
   *     RagIndexingService's index-time pass linked to the seed's source (shared
   *     Document category/tags, or the standing Report<->Snapshot pairing) — see
   *     `relatedSourceIds` on AiEmbeddingChunk.
   * Expansion candidates get a real semantic score (embeddings are already stored,
   * cosine similarity is cheap) but keywordScore is deliberately left at 0: BM25's
   * document-frequency statistics were computed over the *original* filtered
   * candidate set, and re-scoring a different, much smaller expansion set against the
   * query would be a different, incomparable scoring universe rather than a
   * consistent one. These chunks are earning their place through document-
   * relationship reasoning, not keyword relevance — Layer 4's LLM reranker gets the
   * real judgment call on whether they end up mattering. */
  private async expandWithRelationships(
    userId: string,
    seeds: ScoredChunk[],
    queryEmbedding: number[],
    weights: (typeof RETRIEVAL_WEIGHT_PROFILES)[QueryType],
    now: number,
    decayRate: number,
  ): Promise<ScoredChunk[]> {
    if (seeds.length === 0) return [];

    const seedIds = new Set(seeds.map((s) => s.id));
    const seedSourceIds = new Set(seeds.map((s) => s.sourceId));
    const relatedSourceIds = new Set<string>();
    for (const seed of seeds) {
      for (const id of seed.relatedSourceIds) relatedSourceIds.add(id);
    }

    const lookupSourceIds = new Set([...seedSourceIds, ...relatedSourceIds]);
    if (lookupSourceIds.size === 0) return [];

    const pool = await this.prisma.client.aiEmbeddingChunk.findMany({
      where: { userId, sourceId: { in: [...lookupSourceIds] } },
    });

    const siblingsBySeedSource = new Map<string, typeof pool>();
    for (const row of pool) {
      if (!siblingsBySeedSource.has(row.sourceId)) siblingsBySeedSource.set(row.sourceId, []);
      siblingsBySeedSource.get(row.sourceId)!.push(row);
    }

    const expansions: ScoredChunk[] = [];
    const addedIds = new Set<string>();
    let siblingBudget = MAX_SIBLING_EXPANSIONS;
    let relatedBudget = MAX_RELATED_SOURCE_EXPANSIONS;

    for (const seed of seeds) {
      if (siblingBudget <= 0 && relatedBudget <= 0) break;

      if (siblingBudget > 0) {
        const sameSourceRows = siblingsBySeedSource.get(seed.sourceId) ?? [];
        for (const row of sameSourceRows) {
          if (siblingBudget <= 0) break;
          if (seedIds.has(row.id) || addedIds.has(row.id)) continue;
          if (Math.abs(row.chunkIndex - seed.chunkIndex) > SIBLING_EXPANSION_RADIUS) continue;
          addedIds.add(row.id);
          siblingBudget--;
          expansions.push(
            this.scoreChunk(row, cosineSimilarity(queryEmbedding, row.embedding), 0, weights, now, decayRate, "sibling"),
          );
        }
      }

      if (relatedBudget > 0) {
        for (const relatedSourceId of seed.relatedSourceIds) {
          if (relatedBudget <= 0) break;
          const rows = pool.filter((row) => row.sourceId === relatedSourceId);
          for (const row of rows) {
            if (relatedBudget <= 0) break;
            if (seedIds.has(row.id) || addedIds.has(row.id)) continue;
            addedIds.add(row.id);
            relatedBudget--;
            expansions.push(
              this.scoreChunk(row, cosineSimilarity(queryEmbedding, row.embedding), 0, weights, now, decayRate, "related_source"),
            );
          }
        }
      }
    }

    return expansions;
  }
}

/** True unless a metadata-based filter is engaged AND applicable to this chunk's
 * source type AND the chunk fails it — categories/tags only meaningfully exist on
 * DOCUMENT-sourced chunks today (see RagIndexingService#gatherSources), so a filter
 * never silently excludes an entire other source type just because the concept of
 * "category" doesn't apply to it. */
function passesMetadataFilters(sourceType: AiSourceType, metadata: Record<string, unknown>, filters: SearchFilters): boolean {
  if (filters.categories?.length && sourceType === "DOCUMENT") {
    const category = typeof metadata.category === "string" ? metadata.category : undefined;
    if (category && !filters.categories.includes(category)) return false;
  }
  if (filters.tags?.length) {
    const tags = Array.isArray(metadata.tags) ? (metadata.tags as string[]) : [];
    if (tags.length > 0 && !filters.tags.some((t) => tags.includes(t))) return false;
  }
  return true;
}

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return values.map(() => (max === 0 ? 0 : 1));
  return values.map((v) => (v - min) / (max - min));
}

function dedupeById(chunks: ScoredChunk[]): ScoredChunk[] {
  const byId = new Map<string, ScoredChunk>();
  for (const chunk of chunks) {
    const existing = byId.get(chunk.id);
    if (!existing || chunk.combinedScore > existing.combinedScore) byId.set(chunk.id, chunk);
  }
  return [...byId.values()];
}

/** Duplicate chunk suppression: iterates chunks best-score-first and drops any chunk
 * whose tokenized word set has Jaccard similarity >= `threshold` against a chunk
 * already kept. O(n^2) in the candidate pool size, which is fine at the pool sizes
 * this feature ever deals with (a few dozen at most, per MAX_CANDIDATES). Exported so
 * RagService can apply the same suppression a second time across the *merged* pool
 * from multiple multi-hop sub-question searches, where near-duplicates can reappear
 * across sub-questions even though each sub-question's own pool was already
 * deduplicated internally. */
export function suppressNearDuplicates<T extends { id: string; text: string; combinedScore: number }>(
  chunks: T[],
  threshold: number = NEAR_DUPLICATE_JACCARD_THRESHOLD,
): T[] {
  const sorted = [...chunks].sort((a, b) => b.combinedScore - a.combinedScore);
  const kept: { chunk: T; tokens: Set<string> }[] = [];

  for (const chunk of sorted) {
    const tokens = new Set(tokenize(chunk.text));
    const isDuplicate = kept.some((k) => jaccard(tokens, k.tokens) >= threshold);
    if (!isDuplicate) kept.push({ chunk, tokens });
  }

  return kept.map((k) => k.chunk);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
