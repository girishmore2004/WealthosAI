import { Injectable } from "@nestjs/common";
import { ACTIVE_LEARNING_CONFIDENCE_THRESHOLD, ACTIVE_LEARNING_MIN_SAMPLE_SIZE } from "../copilot-ingestion.constants";

export interface SuggestionInputs {
  categorySuggestionConfidence: number;
  isDuplicateCandidate: boolean;
  duplicateConfidence: number;
  isRecurringCandidate: boolean;
  isAnomalyCandidate: boolean;
  missingFields: string[];
  /** How many prior human-confirmed observations personal merchant memory has for
   * this merchant — 0 means "never seen before." Used only to compute
   * needsActiveLearningReview, never folded into overallConfidence itself (a
   * well-established merchant's memory-backed confidence number already reflects its
   * own sample size via decay; this field exists purely to prioritize the review
   * queue, not to double-penalize the score). */
  merchantMemorySampleSize?: number;
  /** Set when this item came from an OCR'd statement image — see
   * OcrQualityEstimationService. A low-quality OCR pass caps confidence the same way a
   * missing field does: the pipeline should never present an OCR-derived line as
   * confidently correct when the extraction itself was shaky. */
  ocrExtractionConfidence?: number;
  /** Set by ReconciliationService.classifyLine() when this line looks like a loan EMI
   * or investment contribution whose amount didn't match the corresponding record (or
   * couldn't be matched to any record at all) — surfaced as a normal confidence-
   * lowering signal, same treatment as a duplicate or anomaly flag. */
  hasReconciliationMismatch?: boolean;
}

export interface SuggestionScore {
  overallConfidence: number;
  rationale: string;
  needsActiveLearningReview: boolean;
}

// Overall confidence is NOT a weighted average of the sub-signals — a suggestion the
// system is otherwise confident about but flags as a likely duplicate should surface
// as LOW overall confidence (needs a human decision) even if the category guess
// itself was clean. This is a deliberate min-of-signals-with-penalties approach
// rather than an averaging one, because averaging would let a strong category guess
// mask a real duplicate/anomaly concern.
@Injectable()
export class SuggestionScoringService {
  score(inputs: SuggestionInputs): SuggestionScore {
    const reasons: string[] = [];
    let confidence = inputs.categorySuggestionConfidence;
    reasons.push(`category suggestion confidence ${Math.round(inputs.categorySuggestionConfidence * 100)}%`);

    if (inputs.isDuplicateCandidate) {
      confidence = Math.min(confidence, 1 - inputs.duplicateConfidence);
      reasons.push(`flagged as a possible duplicate (${Math.round(inputs.duplicateConfidence * 100)}% confidence it's a repeat)`);
    }

    if (inputs.isAnomalyCandidate) {
      confidence = Math.min(confidence, 0.4);
      reasons.push("amount is a statistical outlier for this category");
    }

    if (inputs.isRecurringCandidate) {
      reasons.push("matches an already-detected recurring subscription");
    }

    if (inputs.missingFields.length > 0) {
      confidence = Math.min(confidence, 0.7);
      reasons.push(`missing: ${inputs.missingFields.join(", ")}`);
    }

    if (inputs.ocrExtractionConfidence !== undefined && inputs.ocrExtractionConfidence < 1) {
      confidence = Math.min(confidence, inputs.ocrExtractionConfidence);
      reasons.push(`OCR extraction confidence ${Math.round(inputs.ocrExtractionConfidence * 100)}%`);
    }

    if (inputs.hasReconciliationMismatch) {
      confidence = Math.min(confidence, 0.5);
      reasons.push("doesn't reconcile cleanly against an existing Loan/Investment record");
    }

    const sampleSize = inputs.merchantMemorySampleSize ?? 0;
    const overallConfidence = Math.max(0, Math.min(1, confidence));
    const needsActiveLearningReview = sampleSize < ACTIVE_LEARNING_MIN_SAMPLE_SIZE || overallConfidence < ACTIVE_LEARNING_CONFIDENCE_THRESHOLD;

    return { overallConfidence, rationale: reasons.join("; "), needsActiveLearningReview };
  }
}
