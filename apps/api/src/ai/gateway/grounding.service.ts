import { Injectable } from "@nestjs/common";

export interface GroundingScoreResult {
  /** 0-1, higher is better grounded. See combination formula in score() below. */
  score: number;
  /** Numbers found in the response that had no close match anywhere in the given
   * context — fed back to the model verbatim on AiGatewayService's corrective retry,
   * and included in AiGroundingException's message when a retry still doesn't fix
   * it. */
  unmatchedNumbers: string[];
  risk: "low" | "medium" | "high";
}

interface ExtractedNumber {
  raw: string;
  value: number;
  isPercent: boolean;
}

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "your", "you", "are", "was",
  "were", "have", "has", "had", "not", "but", "can", "will", "would", "should",
  "could", "about", "into", "over", "than", "then", "them", "they", "their", "there",
  "which", "what", "when", "where", "how", "why", "who", "its", "per", "result",
  "confidence",
]);

// A number token: optional leading minus (only when not glued to a preceding digit or dot,
// so "2026-09-12" and "5-10 years" are not read as negative numbers), then either a
// correctly grouped thousands/lakh figure (1,234 / 12,34,567 / 1,234,567) or a plain run
// of digits, an optional decimal part and an optional percent sign.
const NUMBER_PATTERN = /(?<![\d.])-?(?:\d{1,3}(?:,\d{2,3})+(?!\d)|\d+)(?:\.\d+)?%?/g;
// "[0]", "[12]", "[1, 3]" — source/citation markers, never a financial figure.
const CITATION_MARKER_PATTERN = /\[\s*\d{1,3}(?:\s*[,;]\s*\d{1,3})*\s*\]/g;
// A standalone list number at the start of a line: "1. ", "2) ", "- 3. ", "* 4) ".
// Requires whitespace after the punctuation so "12.5% return" and "2.5 lakh" are untouched.
const LIST_MARKER_PATTERN = /^[ \t]*(?:[-*\u2022][ \t]+)?\d{1,3}[.)][ \t]+(?=\S)/gm;
// Object keys whose numeric values are structural positions/identifiers/self-reported
// scores rather than financial claims (e.g. `citedIndices`, `orderedIndices`, `confidence`).
const STRUCTURAL_NUMERIC_KEY = /(?:^|[a-z])(?:Index|Indices|Indexes|Idx|Rank|Position)$|^confidence$/;

/** Projects a structured AI result down to the text a *user would read* — string values,
 * plus numeric values that are not structural (indices, ranks, confidence). Object keys,
 * booleans and array-index bookkeeping are never included. This is the input boundary the
 * grounding check must score: scoring `JSON.stringify(result)` made serialized structure
 * (`"citedIndices":[0,1,2]`) look like figures the model had invented. */
export function collectGroundableText(value: unknown, key?: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    return key !== undefined && STRUCTURAL_NUMERIC_KEY.test(key) ? "" : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => collectGroundableText(item, key)).filter(Boolean).join("\n");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => collectGroundableText(v, k))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// A reusable, gateway-level grounding/hallucination check available to EVERY AI
// feature via AiCallOptions.groundingContext (see ai-gateway.types.ts) — not a
// replacement for ai/coach/verification/numeric-consistency.verifier.ts, which Agentic
// Coach and Scenario Studio already use directly and is more specialized to their
// exact facts-text format; this PR does not touch either of those feature files. This
// class exists so features that DON'T already have a bespoke verifier (RAG synthesis,
// Copilot Ingestion's statement-understanding fallback, any future AI feature) get the
// same category of protection for free just by passing groundingContext, without each
// reimplementing number-extraction-and-matching independently. The numeric-matching
// logic here is intentionally similar in spirit to that verifier (same tolerance
// rules) for consistency of behavior across the codebase, not copy-pasted from it.
@Injectable()
export class GroundingService {
  /** Extracts the material numeric claims in `text` — amounts, percentages, dates' numeric
   * parts, counts — after removing the *unambiguous structural markers* that are not
   * financial content at all:
   *   - a standalone list number at the very start of a line ("1. ", "2) ", "- 3. ")
   *   - bracketed citation/source markers ("[0]", "[2]", "[1, 3]")
   * Everything else is still checked. Thousands separators are only recognised in valid
   * groupings (1,234 / 12,34,567 / 1,234,567), so a bare comma-separated list such as
   * "0,1,2" is read as three separate small numbers rather than one invented figure
   * (the original false positive: serialized `citedIndices: [0,1,2]` was read as 12). */
  private extractNumbers(text: string): ExtractedNumber[] {
    const withoutStructure = text
      .replace(CITATION_MARKER_PATTERN, " ")
      .replace(LIST_MARKER_PATTERN, "");
    const matches = withoutStructure.match(NUMBER_PATTERN) ?? [];
    return matches
      .map((raw) => {
        const isPercent = raw.trim().endsWith("%");
        const cleaned = raw.replace(/[,%\s]/g, "");
        const value = parseFloat(cleaned);
        return Number.isNaN(value) ? null : { raw: raw.trim(), value, isPercent };
      })
      .filter((n): n is ExtractedNumber => n !== null && n.value !== 0); // "0" is too common a false-positive match to be worth verifying
  }

  /** 1% relative tolerance for amounts (min absolute 1, so small counts still require
   * an exact-ish match), 0.15 absolute for percentages — allows for rounding/
   * formatting differences between how context was assembled and how the model
   * rendered a number, without allowing a genuinely different figure through. */
  private numbersClose(a: ExtractedNumber, b: ExtractedNumber): boolean {
    if (a.isPercent !== b.isPercent) return false;
    if (a.isPercent) return Math.abs(a.value - b.value) <= 0.15;
    const tolerance = Math.max(1, Math.abs(b.value) * 0.01);
    return Math.abs(a.value - b.value) <= tolerance;
  }

  private significantWords(text: string): Set<string> {
    const words = text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [];
    return new Set(words.filter((w) => !STOPWORDS.has(w)));
  }

  /** Scores `responseText` against `context` on two independent axes and combines
   * them 60/40 (numeric-consistency-weighted, since a wrong ₹ figure or % is the
   * costlier class of hallucination for a finance app than an unexpected adjective):
   *   1. Numeric axis — fraction of numbers in the response that have a close match
   *      somewhere in the context. A response with no numbers at all scores 1 on this
   *      axis (nothing to have hallucinated numerically), not 0.
   *   2. Lexical axis — fraction of the response's significant (non-stopword) words
   *      that also appear somewhere in the context. Crude but explainable, same
   *      "deterministic formula, not a hidden model" spirit as this codebase's
   *      existing BM25-style keyword scoring in ai/rag/retrieval.
   * Pure function, no I/O — cheap enough to run on every grounded call, including on
   * a cache hit (see AiGatewayService), since the caller's groundingContext can
   * legitimately differ call-to-call even when the cached input text is identical. */
  score(responseText: string, context: string): GroundingScoreResult {
    const responseNumbers = this.extractNumbers(responseText);
    const contextNumbers = this.extractNumbers(context);
    const unmatched = responseNumbers.filter((r) => !contextNumbers.some((c) => this.numbersClose(r, c)));
    const numericScore = responseNumbers.length === 0 ? 1 : 1 - unmatched.length / responseNumbers.length;

    const responseWords = this.significantWords(responseText);
    const contextWords = this.significantWords(context);
    const overlap = [...responseWords].filter((w) => contextWords.has(w)).length;
    const lexicalScore = responseWords.size === 0 ? 1 : overlap / responseWords.size;

    const score = Number((numericScore * 0.6 + lexicalScore * 0.4).toFixed(3));
    const risk: GroundingScoreResult["risk"] = score >= 0.85 ? "low" : score >= 0.6 ? "medium" : "high";

    return { score, unmatchedNumbers: unmatched.map((n) => n.raw), risk };
  }
}
