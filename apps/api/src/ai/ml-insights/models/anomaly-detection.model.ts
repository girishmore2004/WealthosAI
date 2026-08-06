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
  /** NEW — deterministic, rule-based "why might this be unusual" causes (not just the
   * bare fact that it's an outlier). Computed purely from data already in
   * ExpenseTransactionPoint (merchant, isRecurring, spentAt vs. category history) —
   * no LLM involved here, so this stays as stable/testable as the rest of this pure
   * module. AnomalyExplanationService (see ../explanation/) turns this list into a
   * natural-language narrative via the AI Gateway, with this list itself as the
   * always-available, always-correct fallback if that call fails. */
  likelyCauses: string[];
}

const OUTLIER_Z_THRESHOLD = 3.5; // Iglewicz & Hoaglin (1993) — the commonly cited modified-z-score outlier cutoff
const MIN_TRANSACTIONS_FOR_BASELINE = 5; // below this, a category's own history is too thin to call anything "abnormal" for it
const LARGE_MULTIPLE_OF_MEDIAN = 3; // a transaction at 3x+ the category's median is worth calling out by magnitude, not just by z-score

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
          anomalies.push({
            transactionId: t.id,
            categoryName: t.categoryName,
            amount: t.amount,
            categoryMedian: median,
            zScore: Number(z.toFixed(2)),
            likelyCauses: this.likelyCauses(t, categoryTransactions, median, z),
          });
        }
      }
    }

    anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

    // Confidence reflects how much of the user's spending this model could actually
    // evaluate — a user with only 1-2 categories having enough history yet still
    // getting flags should see that reflected as lower confidence, not hidden.
    const confidence = clamp01(categoriesWithEnoughData / Math.max(1, byCategory.size));

    return {
      method: "Per-category median absolute deviation (MAD) with a modified z-score, threshold |z| ≥ 3.5, plus rule-based likely-cause tagging",
      prediction: anomalies,
      confidence,
      contributingFeatures: anomalies.slice(0, 5).map((a) => ({ name: a.categoryName, value: a.amount, contribution: Math.abs(a.zScore) })),
      explanation:
        anomalies.length === 0
          ? "No expense transactions were more than 3.5 median-deviations from their category's typical amount."
          : `${anomalies.length} transaction(s) fall well outside their category's typical range — the largest is "${anomalies[0].categoryName}" at ${anomalies[0].zScore} modified z-score (median for that category is ${anomalies[0].categoryMedian.toFixed(0)}).`,
    };
  }

  /** Deterministic, rule-based candidate explanations for why a flagged transaction
   * might be unusual — deliberately a short list of concrete, checkable facts (not a
   * single vague sentence), so both the UI's rule-based fallback and the LLM
   * explanation (which is only ever allowed to rephrase these, never invent new ones)
   * have real signal to work with. Every rule here is a simple, inspectable
   * comparison against data already on ExpenseTransactionPoint — no new I/O, no
   * hidden model. */
  private likelyCauses(t: ExpenseTransactionPoint, categoryTransactions: ExpenseTransactionPoint[], median: number, z: number): string[] {
    const causes: string[] = [];

    const ratio = median > 0 ? t.amount / median : 0;
    if (ratio >= LARGE_MULTIPLE_OF_MEDIAN) {
      causes.push(`Amount is ${ratio.toFixed(1)}x this category's typical (median) spend`);
    }

    if (t.merchant) {
      const sameMerchantCount = categoryTransactions.filter((o) => o.merchant === t.merchant).length;
      if (sameMerchantCount <= 1) {
        causes.push(`First recorded transaction with merchant "${t.merchant}" in this category`);
      }
    }

    if (t.isRecurring) {
      causes.push("Marked as a recurring expense, but this occurrence deviated sharply from its usual amount");
    }

    const earliestInCategory = categoryTransactions.reduce(
      (earliest, o) => (o.spentAt.getTime() < earliest.spentAt.getTime() ? o : earliest),
      categoryTransactions[0],
    );
    if (earliestInCategory.id === t.id) {
      causes.push("Earliest recorded transaction in this category — no prior history to compare it against");
    }

    if (causes.length === 0) {
      causes.push(
        `Amount sits ${Math.abs(z).toFixed(1)} median-deviations from this category's typical range, with no other identifiable pattern (not a new merchant, not the first transaction, not marked recurring)`,
      );
    }

    return causes;
  }
}
