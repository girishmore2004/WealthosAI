import { Injectable } from "@nestjs/common";

export interface SuggestionInputs {
  categorySuggestionConfidence: number;
  isDuplicateCandidate: boolean;
  duplicateConfidence: number;
  isRecurringCandidate: boolean;
  isAnomalyCandidate: boolean;
  missingFields: string[];
}

export interface SuggestionScore {
  overallConfidence: number;
  rationale: string;
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

    return { overallConfidence: Math.max(0, Math.min(1, confidence)), rationale: reasons.join("; ") };
  }
}
