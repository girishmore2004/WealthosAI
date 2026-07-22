import { Injectable } from "@nestjs/common";

// A real, if minimal, BM25 implementation — not a substring/includes() check. Scores
// a query against a fixed candidate set (the candidate set is exactly the chunks
// HybridRetrievalService already pulled for this user, so document-frequency stats
// are computed over that set, not the whole corpus — appropriate here since retrieval
// is always scoped to one user's own data, never a cross-user index).
const K1 = 1.5;
const B = 0.75;

@Injectable()
export class KeywordScorerService {
  /** Returns a BM25 score per document, aligned by index with `documents`. Scores are
   * not normalized to [0,1] here — HybridRetrievalService normalizes across the
   * candidate set before combining with the other signals. */
  score(query: string, documents: string[]): number[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || documents.length === 0) {
      return documents.map(() => 0);
    }

    const docTokens = documents.map(tokenize);
    const docLengths = docTokens.map((tokens) => tokens.length);
    const avgDocLength = docLengths.reduce((sum, len) => sum + len, 0) / docLengths.length || 1;

    const documentFrequency = new Map<string, number>();
    for (const term of new Set(queryTerms)) {
      const count = docTokens.filter((tokens) => tokens.includes(term)).length;
      documentFrequency.set(term, count);
    }

    return docTokens.map((tokens, docIndex) => {
      let score = 0;
      const termFrequency = countTerms(tokens);
      for (const term of queryTerms) {
        const df = documentFrequency.get(term) ?? 0;
        if (df === 0) continue;
        // Standard Robertson-Sparck Jones IDF, floored at 0 so terms present in every
        // candidate don't push the score negative.
        const idf = Math.max(0, Math.log((documents.length - df + 0.5) / (df + 0.5) + 1));
        const tf = termFrequency.get(term) ?? 0;
        const denominator = tf + K1 * (1 - B + (B * docLengths[docIndex]) / avgDocLength);
        score += idf * ((tf * (K1 + 1)) / (denominator || 1));
      }
      return score;
    });
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function countTerms(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}
