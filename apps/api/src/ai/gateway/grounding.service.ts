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
  private extractNumbers(text: string): ExtractedNumber[] {
    const matches = text.match(/₹?\s?-?\d[\d,]*(\.\d+)?%?/g) ?? [];
    return matches
      .map((raw) => {
        const isPercent = raw.trim().endsWith("%");
        const cleaned = raw.replace(/[₹,%\s]/g, "");
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
