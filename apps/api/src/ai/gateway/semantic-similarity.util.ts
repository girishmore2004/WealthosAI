// A dependency-free, in-process "semantic-ish" similarity used only by
// AiCacheService's semantic cache lookups (see ai-cache.service.ts). This deliberately
// does NOT reuse ai/rag/embedding/embedding.service.ts's neural sentence-embedding
// pipeline: that class is owned by, and scoped to, the RAG feature (a different
// feature from this PR's Gateway-only scope), and RagModule already imports AiModule
// one-directionally (see rag.module.ts's own doc comment) — AiModule importing
// RagModule back for EmbeddingService would create a module cycle, and simply
// registering a second, independent copy of EmbeddingService directly in AiModule
// would silently double the ~90MB transformer model's memory footprint and cold-load
// time in every real deployment of this app (RagModule is never run without AiModule
// also active). A sparse term-frequency cosine similarity is a well-understood,
// zero-dependency, always-available "close enough" measure for cache purposes
// specifically: it doesn't need to understand meaning, only to tell "these two
// prompts are almost certainly asking the same thing" apart from "these are
// different" — and a high similarity threshold (ai.semanticCacheThreshold, default
// 0.94, see configuration.ts) keeps false-positive cache hits rare. If a future phase
// wants true paraphrase-level semantic matching, the right fix is to extract
// EmbeddingService into its own leaf module both AiModule and RagModule can import —
// an infrastructure change, not a Gateway-feature one, so it's out of scope here.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "at", "is", "are",
  "was", "were", "be", "been", "being", "with", "from", "this", "that", "it", "as",
  "by", "if", "so", "do", "does", "did", "will", "would", "can", "could", "should",
  "you", "your", "i", "my", "me", "we", "our", "not", "no", "yes",
]);

export type SparseVector = Map<string, number>;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function toSparseVector(text: string): SparseVector {
  const vector: SparseVector = new Map();
  for (const token of tokenize(text)) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  return vector;
}

export function cosineSimilaritySparse(a: SparseVector, b: SparseVector): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, freq] of small) {
    const otherFreq = large.get(term);
    if (otherFreq) dot += freq * otherFreq;
  }
  let normA = 0;
  for (const freq of a.values()) normA += freq * freq;
  let normB = 0;
  for (const freq of b.values()) normB += freq * freq;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function serializeVector(vector: SparseVector): Record<string, number> {
  return Object.fromEntries(vector);
}

export function deserializeVector(obj: Record<string, number>): SparseVector {
  return new Map(Object.entries(obj));
}
