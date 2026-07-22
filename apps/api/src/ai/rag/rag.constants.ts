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
// plausible.
export const TOP_K_CANDIDATES = 20;
export const TOP_K_RERANKED = 6;

// Below this raw cosine similarity, a chunk is treated as "not actually about the
// query" regardless of its combined score — this is what powers the "no evidence
// found" fallback rather than always returning *something* just because the
// candidate list wasn't empty.
export const MIN_EVIDENCE_SIMILARITY = 0.35;
