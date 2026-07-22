import { Injectable } from "@nestjs/common";
import { ExpenseTransactionPoint } from "../features/feature-extraction.service";
import { medianAbsoluteDeviation, modifiedZScore, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export interface ExpenseAnomaly {
  transactionId: string;
  categoryName: string;
  amount: number;
  categoryMedian: number;
  zScore: number;
}

const OUTLIER_Z_THRESHOLD = 3.5; // Iglewicz & Hoaglin (1993) — the commonly cited modified-z-score outlier cutoff
const MIN_TRANSACTIONS_FOR_BASELINE = 5; // below this, a category's own history is too thin to call anything "abnormal" for it

@Injectable()
export class AnomalyDetectionModel {
  detect(transactions: ExpenseTransactionPoint[]): ModelOutput<ExpenseAnomaly[]> {
    const byCategory = new Map<string, ExpenseTransactionPoint[]>();
    for (const t of transactions) {
      const list = byCategory.get(t.categoryId) ?? [];
      list.push(t);
      byCategory.set(t.categoryId, list);
    }

    const anomalies: ExpenseAnomaly[] = [];
    let categoriesWithEnoughData = 0;

    for (const [, categoryTransactions] of byCategory) {
      if (categoryTransactions.length < MIN_TRANSACTIONS_FOR_BASELINE) continue;
      categoriesWithEnoughData++;

      const amounts = categoryTransactions.map((t) => t.amount);
      const { median, mad } = medianAbsoluteDeviation(amounts);

      for (const t of categoryTransactions) {
        const z = modifiedZScore(t.amount, median, mad);
        if (Math.abs(z) >= OUTLIER_Z_THRESHOLD) {
          anomalies.push({ transactionId: t.id, categoryName: t.categoryName, amount: t.amount, categoryMedian: median, zScore: Number(z.toFixed(2)) });
        }
      }
    }

    anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

    // Confidence reflects how much of the user's spending this model could actually
    // evaluate — a user with only 1-2 categories having enough history yet still
    // getting flags should see that reflected as lower confidence, not hidden.
    const confidence = clamp01(categoriesWithEnoughData / Math.max(1, byCategory.size));

    return {
      method: "Per-category median absolute deviation (MAD) with a modified z-score, threshold |z| ≥ 3.5",
      prediction: anomalies,
      confidence,
      contributingFeatures: anomalies.slice(0, 5).map((a) => ({ name: a.categoryName, value: a.amount, contribution: Math.abs(a.zScore) })),
      explanation:
        anomalies.length === 0
          ? "No expense transactions were more than 3.5 median-deviations from their category's typical amount."
          : `${anomalies.length} transaction(s) fall well outside their category's typical range — the largest is "${anomalies[0].categoryName}" at ${anomalies[0].zScore} modified z-score (median for that category is ${anomalies[0].categoryMedian.toFixed(0)}).`,
    };
  }
}
