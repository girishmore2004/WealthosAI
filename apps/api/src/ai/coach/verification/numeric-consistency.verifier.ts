import { Injectable } from "@nestjs/common";

export interface ExtractedNumber {
  raw: string;
  value: number;
  isPercent: boolean;
}

export interface VerificationResult {
  passed: boolean;
  unmatchedNumbers: string[];
}

// This is the guardrail that keeps AnswerComposerService honest: the composer is
// allowed to rephrase, summarize, and add color to deterministic facts, but it must
// never introduce a number that isn't already present in the facts it was given. This
// class enforces that in code rather than only prompting for it — a hallucinated
// figure fails verification and AgenticCoachService falls back to a safe answer built
// directly from the facts, never a plausible-sounding composed sentence with numbers
// nobody can trace.
@Injectable()
export class NumericConsistencyVerifier {
  extractNumbers(text: string): ExtractedNumber[] {
    // Matches ₹ amounts (with optional Indian lakh/crore comma grouping), plain
    // numbers, and percentages. Deliberately permissive on formatting since it only
    // needs to find candidates — normalization happens in normalize().
    const matches = text.match(/₹?\s?-?\d[\d,]*(\.\d+)?%?/g) ?? [];
    return matches
      .map((raw) => this.normalize(raw))
      .filter((n): n is ExtractedNumber => n !== null && n.value !== 0); // "0" is too common a false-positive match to be worth verifying
  }

  private normalize(raw: string): ExtractedNumber | null {
    const isPercent = raw.trim().endsWith("%");
    const cleaned = raw.replace(/[₹,%\s]/g, "");
    const value = parseFloat(cleaned);
    if (Number.isNaN(value)) return null;
    return { raw: raw.trim(), value, isPercent };
  }

  /** True if `a` and `b` are close enough to count as "the same number" allowing for
   * formatting/rounding differences between how facts were assembled and how the
   * composer rendered them — a 1% relative tolerance for amounts (min absolute 1, so
   * small counts still require an exact-ish match), 0.15 absolute for percentages
   * (rounding a savings rate to one decimal shouldn't count as a mismatch). */
  private isClose(a: ExtractedNumber, b: ExtractedNumber): boolean {
    if (a.isPercent !== b.isPercent) return false;
    if (a.isPercent) return Math.abs(a.value - b.value) <= 0.15;
    const tolerance = Math.max(1, Math.abs(b.value) * 0.01);
    return Math.abs(a.value - b.value) <= tolerance;
  }

  verify(composedText: string, factsText: string): VerificationResult {
    const composedNumbers = this.extractNumbers(composedText);
    const factNumbers = this.extractNumbers(factsText);

    const unmatched = composedNumbers.filter(
      (composed) => !factNumbers.some((fact) => this.isClose(composed, fact)),
    );

    return {
      passed: unmatched.length === 0,
      unmatchedNumbers: unmatched.map((n) => n.raw),
    };
  }
}
