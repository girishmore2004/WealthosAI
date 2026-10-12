import { Injectable } from "@nestjs/common";

// A real BM25 implementation tuned for personal-finance text. On top of plain BM25 it adds
// four things that matter for accuracy on short, number-heavy finance records:
//   1. stop-word removal, so "tell me about my insurance" is matched on "insurance", not on
//      "tell", "me" and "my";
//   2. light stemming, so "premiums" matches "premium" and "invested" matches "investment";
//   3. finance synonym groups, so "premium" also finds "insurance policy", and "emi" finds a
//      loan record (expansion terms count for less than the words the user actually typed);
//   4. a phrase bonus, so "home loan" ranks a chunk containing that exact phrase above one
//      that only has "home" and "loan" far apart.
// Scores are computed against a fixed candidate set (the chunks HybridRetrievalService already
// pulled for this one user), so document-frequency statistics are per-user, never cross-user.
const K1 = 1.5;
const B = 0.75;
// Expansion (synonym) terms are real evidence but weaker than the user's own words.
const EXPANSION_WEIGHT = 0.45;
const PHRASE_BONUS = 0.6;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "of", "to", "in", "on", "at", "by", "for", "with", "from", "as",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "have", "has", "had", "it", "its", "this", "that",
  "these", "those", "me", "my", "mine", "i", "we", "our", "you", "your", "about", "tell", "show", "give", "get", "let",
  "what", "which", "who", "whom", "how", "much", "many", "when", "where", "why", "can", "could", "should", "would", "will",
  "please", "any", "all", "some", "there", "here", "so", "than", "also", "just", "into", "up", "out", "need", "want", "know",
  "list", "detail", "details", "explain", "summary",
]);

// Each inner array is one concept; any word in a group pulls in the others as weaker matches.
// Entries are already stemmed (see stem()) so they line up with the stemmed documents.
const SYNONYM_GROUPS: string[][] = [
  ["insurance", "insure", "policy", "polic", "premium", "cover", "coverage", "nominee", "renewal", "claim", "term", "health"],
  ["loan", "emi", "mortgage", "debt", "borrow", "lender", "outstanding", "principal", "interest", "tenure", "prepay", "prepayment"],
  ["invest", "investment", "sip", "mutual", "fund", "stock", "equity", "portfolio", "nav", "ppf", "nps", "fd", "deposit", "gold", "etf"],
  ["expense", "spend", "spending", "spent", "payment", "cost", "bill", "purchase", "outflow"],
  ["income", "salary", "earn", "earning", "earned", "paycheck", "ctc", "payout", "receive", "received", "revenue"],
  ["emergency", "reserve", "rainy", "buffer", "contingency", "safety"],
  ["networth", "net", "worth", "asset", "liability", "wealth"],
  ["tax", "itr", "deduction", "80c", "80d", "tds", "gst"],
  ["goal", "target", "objective", "milestone"],
  ["rent", "landlord", "lease", "housing"],
  ["saving", "savings", "save", "surplus"],
  ["grocery", "groceries", "food", "supermarket", "dining", "restaurant"],
  ["receivable", "lent", "lend", "owed", "borrowed", "repay", "repaid", "repayment"],
];

const SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      const bucket = map.get(word) ?? new Set<string>();
      for (const other of group) if (other !== word) bucket.add(other);
      map.set(word, bucket);
    }
  }
  return map;
})();

export interface KeywordMatch {
  /** Raw BM25 score (not normalised). */
  score: number;
  /** Fraction (0-1) of the user's own distinct content words found in the document,
   * after stemming. 1 means every word the user typed appears; used as the lexical
   * "is this really about the question" signal when no embedding is available. */
  coverage: number;
}

@Injectable()
export class KeywordScorerService {
  /** Returns a BM25 score per document, aligned by index with `documents`. Scores are
   * not normalized to [0,1] here — HybridRetrievalService normalizes across the
   * candidate set before combining with the other signals. */
  score(query: string, documents: string[]): number[] {
    return this.match(query, documents).map((m) => m.score);
  }

  match(query: string, documents: string[]): KeywordMatch[] {
    const queryTerms = contentTerms(query);
    if (queryTerms.length === 0 || documents.length === 0) {
      return documents.map(() => ({ score: 0, coverage: 0 }));
    }

    const docTokens = documents.map((d) => analyze(d));
    const docLengths = docTokens.map((tokens) => tokens.length);
    const avgDocLength = docLengths.reduce((sum, len) => sum + len, 0) / docLengths.length || 1;

    // Weighted query terms: the user's own words at 1.0, synonyms at EXPANSION_WEIGHT.
    const weights = new Map<string, number>();
    for (const term of queryTerms) weights.set(term, 1);
    for (const term of queryTerms) {
      for (const syn of SYNONYM_INDEX.get(term) ?? []) {
        if (!weights.has(syn)) weights.set(syn, EXPANSION_WEIGHT);
      }
    }

    const documentFrequency = new Map<string, number>();
    const termSets = docTokens.map((tokens) => new Set(tokens));
    for (const term of weights.keys()) {
      documentFrequency.set(term, termSets.filter((set) => set.has(term)).length);
    }

    const distinctQueryTerms = [...new Set(queryTerms)];
    const bigrams = queryBigrams(queryTerms);

    return docTokens.map((tokens, docIndex) => {
      const termFrequency = countTerms(tokens);
      let score = 0;
      for (const [term, weight] of weights) {
        const df = documentFrequency.get(term) ?? 0;
        if (df === 0) continue;
        // Standard Robertson-Sparck Jones IDF, floored at 0 so terms present in every
        // candidate don't push the score negative.
        const idf = Math.max(0, Math.log((documents.length - df + 0.5) / (df + 0.5) + 1));
        const tf = termFrequency.get(term) ?? 0;
        const denominator = tf + K1 * (1 - B + (B * docLengths[docIndex]) / avgDocLength);
        score += weight * idf * ((tf * (K1 + 1)) / (denominator || 1));
      }

      if (bigrams.length > 0 && score > 0) {
        const joined = ` ${tokens.join(" ")} `;
        const hits = bigrams.filter(([a, b]) => joined.includes(` ${a} ${b} `)).length;
        score *= 1 + PHRASE_BONUS * (hits / bigrams.length);
      }

      const present = distinctQueryTerms.filter((t) => termSets[docIndex].has(t)).length;
      return { score, coverage: distinctQueryTerms.length === 0 ? 0 : present / distinctQueryTerms.length };
    });
  }
}

// Exported so HybridRetrievalService's near-duplicate suppression (Jaccard similarity
// over token sets) uses the same tokenization as BM25 scoring — one definition of
// "what counts as a word" for this feature, not two that could quietly drift apart.
// This is the plain tokenizer (no stop-word removal or stemming): numbers written with
// thousands separators stay one token ("13,06,555" -> "1306555").
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Tokenize + stem (no stop-word removal), used for documents. */
export function analyze(text: string): string[] {
  return tokenize(text).map(stem);
}

/** The user's meaningful words: tokenized, stop words removed, stemmed. Falls back to
 * all tokens when the question is made only of stop words (e.g. "what is it"), so a
 * query is never silently reduced to nothing. */
export function contentTerms(query: string): string[] {
  const tokens = tokenize(query);
  const content = tokens.filter((t) => !STOPWORDS.has(t));
  return (content.length > 0 ? content : tokens).map(stem);
}

/** Related finance terms for a question, used to build an extra search phrasing. */
export function expansionTerms(query: string): string[] {
  const terms = new Set(contentTerms(query));
  const extra = new Set<string>();
  for (const term of terms) {
    for (const syn of SYNONYM_INDEX.get(term) ?? []) if (!terms.has(syn)) extra.add(syn);
  }
  return [...extra].slice(0, 8);
}

/** Conservative suffix stripping. Not a linguistic stemmer: it only needs to map the same
 * word's common forms to the same key on both the query and document side. */
export function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4 && /(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function queryBigrams(terms: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < terms.length - 1; i++) out.push([terms[i], terms[i + 1]]);
  return out;
}

function countTerms(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}
