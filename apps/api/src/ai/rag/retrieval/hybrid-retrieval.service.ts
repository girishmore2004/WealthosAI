import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { AiSourceType } from "@wealthos/db";
import { EmbeddingService, cosineSimilarity } from "../embedding/embedding.service";
import { KeywordMatch, KeywordScorerService, tokenize } from "./keyword-scorer.service";
import {
  LEXICAL_EVIDENCE_MIN_COVERAGE,
  MAX_CHUNKS_PER_SOURCE,
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
  /** The searching user's already-loaded, already-metadata-filtered candidate rows (from loadCandidates).
   * RagService loads them once per search and reuses them for every phrasing / sub-question instead of
   * re-reading the user's whole chunk table each time. They MUST have been loaded for the same userId and
   * filters as this call; they are never shared across searches or users. */
  candidates?: CandidateRows;
  /** Source types the user explicitly named ("my alerts", "the monthly report"). A soft ranking boost —
   * never a filter, so evidence from other sources is still found. */
  boostSourceTypes?: AiSourceType[];
}

export type CandidateRows = Awaited<ReturnType<HybridRetrievalService["loadCandidates"]>>;

// Added to a chunk's combined score when the user named its source type and the chunk also matched the
// question's terms (a chunk that matched nothing is never lifted just for its type).
const EXPLICIT_SOURCE_BOOST = 0.15;

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
  /** Fraction (0-1) of the question's own content words found in this chunk (after stemming). The
   * lexical "is this really about the question" signal; counts as evidence when the semantic score is
   * low or unavailable (hashed fallback / stale vectors). Optional: absent on hand-built chunks. */
  lexicalCoverage?: number;
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
  private readonly logger = new Logger(HybridRetrievalService.name);

  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
    private keywordScorer: KeywordScorerService,
  ) {}

  /** One read of the user's own chunk rows (always `WHERE userId = …`), narrowed by the request's
   * source-type / date / metadata filters. Exposed so one search can read once and score many phrasings. */
  async loadCandidates(userId: string, filters: SearchFilters = {}) {
    const rawCandidates = await this.prisma.client.aiEmbeddingChunk.findMany({
      where: {
        userId,
        ...(filters.sourceTypes?.length ? { sourceType: { in: filters.sourceTypes } } : {}),
        ...(filters.dateFrom || filters.dateTo
          ? { sourceCreatedAt: { gte: filters.dateFrom, lte: filters.dateTo } }
          : {}),
      },
    });
    return rawCandidates.filter((c) => passesMetadataFilters(c.sourceType, c.metadata as Record<string, unknown>, filters));
  }

  async search(
    userId: string,
    query: string,
    filters: SearchFilters = {},
    queryContext: QueryContext = {},
  ): Promise<ScoredChunk[]> {
    const queryType: QueryType = queryContext.queryType ?? "exploratory";
    const complexity: QueryComplexity = queryContext.complexity ?? "moderate";
    const candidateLimit = adaptiveCandidateLimit(complexity);

    const tStart = Date.now();
    const filtered = queryContext.candidates ?? (await this.loadCandidates(userId, filters));
    const tLoad = Date.now();
    if (filtered.length === 0) {
      // An empty candidate set is the one retrieval outcome that is invisible otherwise (the timing line
      // below never runs). Say which filters were active — counts and flags only, no values.
      this.logger.warn(
        `retrieval found no indexed chunks ${JSON.stringify({ sharedRows: Boolean(queryContext.candidates), sourceTypeFilter: filters.sourceTypes?.length ?? 0, dateFilter: Boolean(filters.dateFrom || filters.dateTo), categoryFilter: filters.categories?.length ?? 0, tagFilter: filters.tags?.length ?? 0, loadMs: tLoad - tStart })}`,
      );
      return [];
    }

    // The query vector. If the embedding backend is unusable the search still works: it falls back to
    // lexical-only ranking (BM25 + recency + priority) instead of failing the whole request.
    let queryEmbedding: number[] | null = null;
    let queryVersion: number | undefined;
    try {
      if (typeof this.embedding.embedWithVersion === "function") {
        const result = await this.embedding.embedWithVersion(query);
        queryEmbedding = result.vector;
        queryVersion = result.version;
      } else {
        queryEmbedding = await this.embedding.embed(query);
      }
    } catch (err) {
      this.logger.warn(`Query embedding unavailable, ranking lexically only: ${(err as Error).message}`);
    }

    const tEmbed = Date.now();
    const baseWeights = RETRIEVAL_WEIGHT_PROFILES[queryType];
    const weights = queryEmbedding
      ? baseWeights
      : { ...baseWeights, semantic: 0, keyword: baseWeights.keyword + baseWeights.semantic };
    // Only vectors from the same embedding space as the query are comparable. A chunk stored under a
    // different version (mid-migration, or fallback vs neural) gets no semantic credit rather than a
    // meaningless cosine value; it can still win on keywords.
    const semanticOf = (chunk: { embedding: number[]; embeddingModelVersion?: number }): number => {
      if (!queryEmbedding) return 0;
      if (queryVersion !== undefined && chunk.embeddingModelVersion !== undefined && chunk.embeddingModelVersion !== queryVersion) return 0;
      return cosineSimilarity(queryEmbedding, chunk.embedding);
    };

    // A chunk's title (document file name, policy name, report month) is searchable text too.
    const searchable = filtered.map((c) => {
      const title = (c.metadata as Record<string, unknown> | null)?.title;
      return typeof title === "string" && title && !c.text.startsWith(title) ? `${title}\n${c.text}` : c.text;
    });
    const matches: KeywordMatch[] =
      typeof this.keywordScorer.match === "function"
        ? this.keywordScorer.match(query, searchable)
        : this.keywordScorer.score(query, searchable).map((score) => ({ score, coverage: 0 }));
    const keywordScores = normalize(matches.map((m) => m.score));
    const now = Date.now();
    const decayRate = Math.LN2 / (RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000);

    const seeds: ScoredChunk[] = filtered.map((chunk, i) => ({
      ...this.scoreChunk(chunk, semanticOf(chunk), keywordScores[i], weights, now, decayRate, "seed"),
      lexicalCoverage: matches[i].coverage,
    }));
    if (queryContext.boostSourceTypes?.length) {
      for (const seed of seeds) {
        if (queryContext.boostSourceTypes.includes(seed.sourceType) && (seed.keywordScore > 0 || seed.semanticScore > 0)) {
          seed.combinedScore += EXPLICIT_SOURCE_BOOST;
        }
      }
    }
    seeds.sort((a, b) => b.combinedScore - a.combinedScore);

    const seedSlice = seeds.slice(0, candidateLimit);
    // With no request filters the shared in-memory rows ARE the user's whole chunk set, so relationship
    // expansion can read them directly instead of making another database round trip per phrasing.
    const unfiltered = !(filters.sourceTypes?.length || filters.dateFrom || filters.dateTo || filters.categories?.length || filters.tags?.length);
    const expansions = await this.expandWithRelationships(userId, seedSlice, semanticOf, weights, now, decayRate, unfiltered ? queryContext.candidates : undefined);

    const pool = dedupeById([...seedSlice, ...expansions]);
    const deduped = suppressNearDuplicates(pool, NEAR_DUPLICATE_JACCARD_THRESHOLD);

    const result = capPerSource(deduped.sort((a, b) => b.combinedScore - a.combinedScore), MAX_CHUNKS_PER_SOURCE).slice(0, candidateLimit);
    // Where retrieval time goes (counts and milliseconds only): reading rows vs embedding the query vs scoring.
    this.logger.log(
      `retrieval timing ${JSON.stringify({ rows: filtered.length, sharedRows: Boolean(queryContext.candidates), loadMs: tLoad - tStart, embedMs: tEmbed - tLoad, scoreMs: Date.now() - tEmbed, ms: Date.now() - tStart })}`,
    );
    return result;
  }

  /** Whether any candidate is actually similar enough to the query to count as real
   * evidence — see rag.constants.ts#MIN_EVIDENCE_SIMILARITY. Used by RagService to
   * decide whether to skip generation entirely rather than answer from weak matches.
   * Deliberately checks semanticScore only, not combinedScore — a chunk that's
   * recent/high-priority but not actually similar to the query shouldn't count as
   * "evidence found" just because those other signals inflated its combined score.
   *
   * Only counts seed chunks (chunks retrieved directly via semantic/keyword search
   * against the query) — a Layer-3 expansion chunk (sibling/related_source; see
   * expandWithRelationships) was pulled into the pool via a *relationship* to a seed,
   * not because it's independently similar to the query text itself, so a
   * high-scoring expansion chunk alone must not count as evidence that the corpus
   * actually answers the question. Chunks with no expansionReason set at all (e.g.
   * plain scored chunks not produced through the seed/expansion pipeline) are treated
   * like seeds and do count. */
  hasEvidence(scoredChunks: ScoredChunk[]): boolean {
    return scoredChunks.some((c) => {
      const isSeed = c.expansionReason === undefined || c.expansionReason === "seed";
      if (!isSeed) return false;
      if (c.semanticScore >= MIN_EVIDENCE_SIMILARITY) return true;
      // Lexical evidence: most of the user's own content words literally appear in the chunk. This keeps
      // a precise question ("what is my EMI") answerable when the semantic score is modest or when the
      // hashed fallback (which has lower absolute similarities) is in use.
      return (c.lexicalCoverage ?? 0) >= LEXICAL_EVIDENCE_MIN_COVERAGE && c.keywordScore > 0;
    });
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
    semanticOf: (chunk: { embedding: number[]; embeddingModelVersion?: number }) => number,
    weights: (typeof RETRIEVAL_WEIGHT_PROFILES)[QueryType],
    now: number,
    decayRate: number,
    preloaded?: CandidateRows,
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

    // Same user's rows either way: `preloaded` was itself loaded `WHERE userId = …` for this search.
    const pool = preloaded
      ? preloaded.filter((row) => lookupSourceIds.has(row.sourceId))
      : await this.prisma.client.aiEmbeddingChunk.findMany({
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
            this.scoreChunk(row, semanticOf(row), 0, weights, now, decayRate, "sibling"),
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
              this.scoreChunk(row, semanticOf(row), 0, weights, now, decayRate, "related_source"),
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

/** Keeps at most `max` chunks per source (best-scored first, input order preserved): one long document
 * or report must not crowd every other source out of the candidate pool and the answer context. */
function capPerSource<T extends { sourceType: string; sourceId: string }>(chunks: T[], max: number): T[] {
  const counts = new Map<string, number>();
  return chunks.filter((c) => {
    const key = `${c.sourceType}:${c.sourceId}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= max;
  });
}

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return values.map(() => (max === 0 ? 0 : 1));
  return values.map((v) => (v - min) / (max - min));
}

/** Merges candidate pools from several phrasings / sub-questions. A chunk found by more than one keeps its
 * best-scoring version, but carries the BEST lexical coverage and keyword signal any phrasing gave it:
 * the evidence bar asks "did any phrasing find this to be about the question", and judging it only by the
 * phrasing that happened to rank it highest let a looser phrasing hide real evidence. Ranking
 * (combinedScore) is untouched. */
export function mergeCandidatePools(pools: ScoredChunk[][]): ScoredChunk[] {
  const byId = new Map<string, ScoredChunk>();
  const bestCoverage = new Map<string, number>();
  const bestKeyword = new Map<string, number>();
  for (const chunk of pools.flat()) {
    bestCoverage.set(chunk.id, Math.max(bestCoverage.get(chunk.id) ?? 0, chunk.lexicalCoverage ?? 0));
    bestKeyword.set(chunk.id, Math.max(bestKeyword.get(chunk.id) ?? 0, chunk.keywordScore));
    const existing = byId.get(chunk.id);
    if (!existing || chunk.combinedScore > existing.combinedScore) byId.set(chunk.id, chunk);
  }
  return [...byId.values()]
    .map((c) => ({ ...c, lexicalCoverage: bestCoverage.get(c.id), keywordScore: bestKeyword.get(c.id) ?? c.keywordScore }))
    .sort((a, b) => b.combinedScore - a.combinedScore);
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
  const kept: { chunk: T; tokens: Set<string>; figures: string }[] = [];

  for (const chunk of sorted) {
    const tokens = new Set(tokenize(chunk.text));
    const figures = figureSignature(tokens);
    // Two chunks that read the same but state DIFFERENT figures (a premium that changed, two versions of a
    // policy, a stale and a current value) are not duplicates — they are the conflicting / outdated
    // evidence the answer must surface. Only chunks with the same figures are suppressed.
    const isDuplicate = kept.some((k) => k.figures === figures && jaccard(tokens, k.tokens) >= threshold);
    if (!isDuplicate) kept.push({ chunk, tokens, figures });
  }

  return kept.map((k) => k.chunk);
}

/** The sorted set of numeric tokens in a chunk, as one comparable string. */
function figureSignature(tokens: Set<string>): string {
  return [...tokens].filter((t) => /\d/.test(t)).sort().join("|");
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
