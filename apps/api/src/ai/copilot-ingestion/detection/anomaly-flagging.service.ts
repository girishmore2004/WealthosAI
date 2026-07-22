import { Injectable } from "@nestjs/common";
import { AnomalyDetectionModel } from "../../ml-insights/models/anomaly-detection.model";
import { ExpenseTransactionPoint } from "../../ml-insights/features/feature-extraction.service";

export interface AnomalyCheckResult {
  isAnomalyCandidate: boolean;
  anomalyZScore: number | null;
}

const CANDIDATE_ID = "__candidate__";

@Injectable()
export class AnomalyFlaggingService {
  constructor(private anomalyModel: AnomalyDetectionModel) {}

  /** Runs the exact same MAD/modified-z-score model Phase 14 uses on the Dashboard,
   * with the candidate transaction inserted alongside the user's existing same-
   * category history — so "is this amount unusual" means the same thing here as it
   * does everywhere else in the app, not a second, different anomaly definition. */
  check(candidate: { amount: number }, categoryId: string, existingSameCategoryTransactions: ExpenseTransactionPoint[]): AnomalyCheckResult {
    const withCandidate: ExpenseTransactionPoint[] = [
      ...existingSameCategoryTransactions,
      { id: CANDIDATE_ID, categoryId, categoryName: existingSameCategoryTransactions[0]?.categoryName ?? "", amount: candidate.amount, spentAt: new Date() },
    ];

    const result = this.anomalyModel.detect(withCandidate);
    const flagged = result.prediction.find((a) => a.transactionId === CANDIDATE_ID);

    return { isAnomalyCandidate: Boolean(flagged), anomalyZScore: flagged?.zScore ?? null };
  }
}
