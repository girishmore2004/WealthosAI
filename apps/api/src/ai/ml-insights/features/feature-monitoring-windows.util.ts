import { ExpenseTransactionPoint, MonthlyPoint } from "./feature-extraction.service";
import { MonitoredFeatureWindow } from "../models/feature-monitoring.model";

// How many of the most recent active months count as the "current" window that gets
// compared against everything before it (the "reference" window) — short enough to
// react to a genuinely recent shift, long enough to not be a single noisy month.
const CURRENT_WINDOW_MONTHS = 3;

function monthKeyOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Pure reshaping of data FeatureExtractionService already fetched (no new I/O) into
 * the reference-window-vs-current-window numeric vectors FeatureMonitoringModel
 * expects, for a small set of named, engineered features. Splits purely by calendar
 * recency: the last CURRENT_WINDOW_MONTHS active months are "current", everything
 * earlier in the fetched history is "reference" — the same reference-vs-recent
 * framing DriftDetectionModel/ConceptDriftModel use elsewhere in this module, applied
 * here to raw input features instead of a model's target or its error. */
export function buildFeatureMonitoringWindows(
  transactions: ExpenseTransactionPoint[],
  monthlySeries: MonthlyPoint[],
): MonitoredFeatureWindow[] {
  const activeMonths = monthlySeries.filter((m) => m.totalIncome !== 0 || m.totalExpenses !== 0).map((m) => m.month);
  if (activeMonths.length === 0) return [];

  const currentMonths = new Set(activeMonths.slice(-CURRENT_WINDOW_MONTHS));
  const referenceMonths = new Set(activeMonths.slice(0, Math.max(0, activeMonths.length - CURRENT_WINDOW_MONTHS)));

  const byMonth = new Map<string, ExpenseTransactionPoint[]>();
  for (const t of transactions) {
    const key = monthKeyOf(t.spentAt);
    byMonth.set(key, [...(byMonth.get(key) ?? []), t]);
  }

  const amountsIn = (months: Set<string>): number[] => [...months].flatMap((m) => (byMonth.get(m) ?? []).map((t) => t.amount));
  const countsIn = (months: Set<string>): number[] => [...months].map((m) => (byMonth.get(m) ?? []).length);
  const categoryDiversityIn = (months: Set<string>): number[] =>
    [...months].map((m) => new Set((byMonth.get(m) ?? []).map((t) => t.categoryId)).size);

  return [
    { name: "Avg transaction amount (₹)", reference: amountsIn(referenceMonths), current: amountsIn(currentMonths) },
    { name: "Transactions per month", reference: countsIn(referenceMonths), current: countsIn(currentMonths) },
    {
      name: "Distinct categories used per month",
      reference: categoryDiversityIn(referenceMonths),
      current: categoryDiversityIn(currentMonths),
    },
  ];
}
