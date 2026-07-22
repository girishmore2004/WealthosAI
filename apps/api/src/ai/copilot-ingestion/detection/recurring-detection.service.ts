import { Injectable } from "@nestjs/common";
import { normalizeMerchantText } from "../merchant/merchant-normalization";

export interface SubscriptionCandidate {
  merchant: string;
  averageAmount: number;
  confidence: "HIGH" | "MEDIUM";
}

export interface RecurringCheckResult {
  isRecurringCandidate: boolean;
  recurringMatchMerchant: string | null;
}

// Deliberately does not re-implement recurrence detection — ExpensesService already
// has a real, working detector (`detectSubscriptions`, same "same merchant + similar
// amount across months" logic this app already trusts for the Subscriptions page).
// This service's only job is matching a freshly-parsed candidate transaction against
// that existing output, so ingestion review and the Subscriptions page can never
// disagree about what counts as recurring.
@Injectable()
export class RecurringDetectionService {
  check(candidate: { merchantRaw: string }, knownSubscriptions: SubscriptionCandidate[]): RecurringCheckResult {
    const candidateMerchant = normalizeMerchantText(candidate.merchantRaw).toLowerCase();

    const match = knownSubscriptions.find((s) => normalizeMerchantText(s.merchant).toLowerCase() === candidateMerchant);

    return {
      isRecurringCandidate: Boolean(match),
      recurringMatchMerchant: match?.merchant ?? null,
    };
  }
}
