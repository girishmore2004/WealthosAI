import { Injectable } from "@nestjs/common";
import { EXACT_DUPLICATE_AMOUNT_TOLERANCE, NEAR_DUPLICATE_AMOUNT_TOLERANCE_FRACTION, NEAR_DUPLICATE_DATE_TOLERANCE_DAYS } from "../copilot-ingestion.constants";
import { normalizeMerchantText } from "../merchant/merchant-normalization";

export interface ExistingExpenseForDupeCheck {
  id: string;
  merchant: string | null;
  amount: number;
  spentAt: Date;
}

export interface DuplicateCheckResult {
  isDuplicateCandidate: boolean;
  duplicateOfExpenseId: string | null;
  duplicateConfidence: number; // 0-1
  reason: string;
}

@Injectable()
export class DuplicateDetectionService {
  check(candidate: { merchantRaw: string; amount: number; date: Date }, existing: ExistingExpenseForDupeCheck[]): DuplicateCheckResult {
    const candidateMerchant = normalizeMerchantText(candidate.merchantRaw).toLowerCase();

    let best: DuplicateCheckResult = { isDuplicateCandidate: false, duplicateOfExpenseId: null, duplicateConfidence: 0, reason: "No matching existing expense found." };

    for (const e of existing) {
      if (!e.merchant) continue;
      const existingMerchant = normalizeMerchantText(e.merchant).toLowerCase();
      if (existingMerchant !== candidateMerchant) continue;

      const amountDiff = Math.abs(e.amount - candidate.amount);
      const dayDiff = Math.abs(daysBetween(e.spentAt, candidate.date));

      // Exact tier: same normalized merchant, same day, amount within a tiny
      // rounding tolerance — very likely the identical transaction re-imported.
      if (dayDiff === 0 && amountDiff <= EXACT_DUPLICATE_AMOUNT_TOLERANCE) {
        return {
          isDuplicateCandidate: true,
          duplicateOfExpenseId: e.id,
          duplicateConfidence: 0.95,
          reason: `Same merchant, same date, amount within ₹${EXACT_DUPLICATE_AMOUNT_TOLERANCE} of an existing expense.`,
        };
      }

      // Near tier: same merchant, close date, amount within a small percentage —
      // flagged with lower confidence rather than auto-treated as certain, since a
      // recurring charge (e.g. a subscription) legitimately produces this pattern
      // every month without being a duplicate.
      const amountFraction = e.amount === 0 ? 1 : amountDiff / e.amount;
      if (dayDiff <= NEAR_DUPLICATE_DATE_TOLERANCE_DAYS && amountFraction <= NEAR_DUPLICATE_AMOUNT_TOLERANCE_FRACTION) {
        const candidateResult: DuplicateCheckResult = {
          isDuplicateCandidate: true,
          duplicateOfExpenseId: e.id,
          duplicateConfidence: 0.6,
          reason: `Same merchant within ${NEAR_DUPLICATE_DATE_TOLERANCE_DAYS} day(s) and ${(NEAR_DUPLICATE_AMOUNT_TOLERANCE_FRACTION * 100).toFixed(0)}% amount of an existing expense — could be a duplicate or a legitimate recurring charge.`,
        };
        if (candidateResult.duplicateConfidence > best.duplicateConfidence) best = candidateResult;
      }
    }

    return best;
  }
}

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((b.getTime() - a.getTime()) / msPerDay);
}
