import { AiSourceType } from "@wealthos/db";

// Static per-sourceType trust weight, assigned at index time (RagIndexingService) and
// read at retrieval time (HybridRetrievalService) — a Document the user uploaded
// themselves or a computed Report is more authoritative than an Alert's short
// templated message, so it's weighted higher in the combined score. Deliberately a
// flat lookup table, not a learned weighting — there's no training signal (e.g. click
// feedback) in this app to learn from yet, and a hand-set priority is honest about
// that rather than dressing up a guess as something learned.
export const SOURCE_PRIORITY: Record<AiSourceType, number> = {
  DOCUMENT: 3,
  REPORT: 3,
  SNAPSHOT: 2,
  COACH_INTERACTION: 2,
  ALERT: 1,
};

export const MAX_SOURCE_PRIORITY = 3;

// Combined score = semantic*W_SEMANTIC + keyword*W_KEYWORD + recency*W_RECENCY +
// priority*W_PRIORITY, each signal pre-normalized to [0,1]. Semantic similarity gets
// the largest weight because it's the signal most robust to the user phrasing their
// question differently than the source text — keyword/recency/priority are there to
// break ties and correct cases where semantic similarity alone would surface a
// topically-similar but stale or low-trust chunk over a more relevant recent one.
export const RETRIEVAL_WEIGHTS = {
  semantic: 0.5,
  keyword: 0.25,
  recency: 0.15,
  priority: 0.1,
};

// Exponential recency decay half-life — a chunk from exactly this many days ago scores
// 0.5 on the recency signal, one from twice that long ago scores 0.25, etc. 90 days
// balances "don't bury a still-relevant three-month-old document" against "a stale
// alert from last year shouldn't compete with this month's data" for a personal
// finance app where most of what's indexed (reports, snapshots) is naturally
// month-cadenced.
export const RECENCY_HALF_LIFE_DAYS = 90;

// How many candidates hybrid retrieval pulls before reranking, and how many survive
// reranking to reach answer synthesis. Reranking is a real (if smaller) model call
// per search, so TOP_K_RERANKED intentionally stays small — the synthesis prompt only
// needs the genuinely best few chunks, not everything hybrid search thought was
// plausible. These are the "moderate"-complexity defaults; see adaptiveCandidateLimit
// / adaptiveRerankLimit below for how simple/complex queries scale off them.
export const TOP_K_CANDIDATES = 20;
export const TOP_K_RERANKED = 6;

// Below this raw cosine similarity, a chunk is treated as "not actually about the
// query" regardless of its combined score — this is what powers the "no evidence
// found" fallback rather than always returning *something* just because the
// candidate list wasn't empty.
export const MIN_EVIDENCE_SIMILARITY = 0.35;

// "hybrid weight optimization per query type" — factual lookups lean harder on
// keyword/exact-term matching than an open-ended exploratory question would, while
// comparative/analytical questions lean a little more on recency (both periods being
// compared are usually recent) and priority (trustworthy, computed sources like
// Reports matter more when the answer requires synthesis, not just a lookup).
// `exploratory` is deliberately identical to RETRIEVAL_WEIGHTS — see
// QueryRewriteService's heuristicComplexity() fallback comment for why exploratory is
// the safe default when there's no real classification to go on.
export const RETRIEVAL_WEIGHT_PROFILES: Record<QueryType, typeof RETRIEVAL_WEIGHTS> = {
  exploratory: RETRIEVAL_WEIGHTS,
  factual: { semantic: 0.45, keyword: 0.4, recency: 0.1, priority: 0.05 },
  comparative: { semantic: 0.45, keyword: 0.2, recency: 0.25, priority: 0.1 },
  analytical: { semantic: 0.45, keyword: 0.2, recency: 0.15, priority: 0.2 },
};

export type QueryType = "factual" | "comparative" | "analytical" | "exploratory";
export type QueryComplexity = "simple" | "moderate" | "complex";

// "adaptive top-k based on query complexity" — a simple one-fact lookup doesn't need
// as wide a candidate net as a compound/multi-hop question that has to synthesize
// across several sources, so both the retrieval candidate limit and the post-rerank
// limit scale with the classified complexity rather than staying fixed at the
// TOP_K_* defaults for every query.
export const MIN_CANDIDATES = 10;
export const MAX_CANDIDATES = 40;
export const MIN_RERANKED = 3;
export const MAX_RERANKED = 10;

const CANDIDATE_LIMIT_BY_COMPLEXITY: Record<QueryComplexity, number> = {
  simple: MIN_CANDIDATES,
  moderate: TOP_K_CANDIDATES,
  complex: MAX_CANDIDATES,
};

const RERANK_LIMIT_BY_COMPLEXITY: Record<QueryComplexity, number> = {
  simple: MIN_RERANKED,
  moderate: TOP_K_RERANKED,
  complex: MAX_RERANKED,
};

export function adaptiveCandidateLimit(complexity: QueryComplexity): number {
  return CANDIDATE_LIMIT_BY_COMPLEXITY[complexity];
}

export function adaptiveRerankLimit(complexity: QueryComplexity): number {
  return RERANK_LIMIT_BY_COMPLEXITY[complexity];
}

// How many of the top-scoring (by combinedScore) candidates are ever actually sent to
// the LLM reranker, regardless of how wide adaptiveCandidateLimit let the pool get —
// bounds Layer 4's model call cost independently of Layer 1-3's net width.
export const MAX_RERANK_INPUT_ITEMS = 25;

// Layer 3 (relationship expansion) budgets — how many sibling (same-source, nearby
// chunkIndex) and related-source chunks may be pulled in around the seed matches, and
// how many chunk positions away from a seed still counts as a "sibling".
export const MAX_SIBLING_EXPANSIONS = 6;
export const MAX_RELATED_SOURCE_EXPANSIONS = 6;
export const SIBLING_EXPANSION_RADIUS = 1;

// Jaccard similarity (on tokenized text) at/above which a chunk is considered a
// near-duplicate of one already kept and is dropped — see suppressNearDuplicates().
export const NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.82;

// Bucket thresholds for citationConfidence()'s blended (combinedScore + rerank
// position) score — "high" needs both a strong retrieval score AND an early rerank
// position; "medium" tolerates being weaker on one of those; anything below "medium"
// is surfaced as "low" rather than silently omitted, since the citation is still real
// evidence even if the confidence in it is lower.
export const CITATION_CONFIDENCE_BANDS = {
  high: 0.7,
  medium: 0.45,
};
