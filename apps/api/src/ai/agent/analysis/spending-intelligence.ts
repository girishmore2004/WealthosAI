import { coefficientOfVariation, mean, median, percentChange, ratioPercent, robustZ, round2, sumMoney } from "./financial-math";

// Pure spending analysis over a list of expense transactions. It is deliberately honest about data volume: a category or
// series that is too thin to judge is reported as "not evaluated", and "no anomalies" is only ever said when something was
// actually evaluated. All figures are computed in code; there is no model in this file.

export type SpendClass = "NEED" | "WANT" | "SAVINGS";

export interface SpendingTx {
  id: string;
  date: Date;
  amount: number;
  category: string;
  categoryType: SpendClass;
  merchant: string | null;
  isRecurring: boolean;
}

export const MIN_TX_FOR_CATEGORY_BASELINE = 5; // transactions in a category before one can be called unusual for it
export const MIN_PRIOR_MONTHS_FOR_SPIKE = 3; // complete months of a category before a monthly spike can be judged
export const ROBUST_Z_THRESHOLD = 3.5; // Iglewicz & Hoaglin (1993)
export const MIN_MONTHS_FOR_AVERAGE = 2;
export const MIN_OCCURRENCES_FOR_RECURRING = 3;
export const RECURRING_MAX_CV = 0.15;

export type AnomalyMethod = "transaction_robust_z" | "category_month_robust_z";
export type Severity = "high" | "medium" | "low";

export interface SpendingAnomaly {
  kind: "transaction" | "category_spike";
  subject: string; // merchant/category for a transaction, category for a spike
  transactionId?: string;
  date?: string;
  category: string;
  actual: number;
  expected: number;
  difference: number;
  zScore: number;
  method: AnomalyMethod;
  severity: Severity;
  explanation: string;
}

export interface CategoryLine {
  category: string;
  type: SpendClass;
  current: number;
  previous: number;
  changePercent: number | null;
  typicalMonthly: number | null; // median of earlier complete months (null when none)
  sharePercent: number | null;
}

export interface RecurringItem {
  merchant: string;
  category: string;
  typicalAmount: number;
  occurrences: number;
  monthlyCost: number;
  basis: "flagged_recurring" | "detected_pattern";
}

export interface SavingsOpportunity {
  label: string;
  monthlyAmount: number;
  basis: string; // always says how the number was derived
}

export interface SpendingReport {
  asOf: string;
  currentMonth: string;
  previousMonth: string;
  monthlyTotals: { month: string; total: number; complete: boolean }[];
  currentTotal: number;
  previousTotal: number;
  changePercent: number | null;
  averageMonthly: number | null;
  medianMonthly: number | null;
  completeMonthsUsed: number;
  categories: CategoryLine[];
  essentialTotal: number;
  discretionaryTotal: number;
  savingsTypeTotal: number;
  largest: { id: string; date: string; merchant: string | null; category: string; amount: number }[];
  recurring: RecurringItem[];
  recurringMonthlyTotal: number;
  anomalies: SpendingAnomaly[];
  anomalyStatus: "evaluated" | "insufficient_history";
  anomalyCoverage: { categoriesEvaluated: number; categoriesTotal: number; categorySeriesEvaluated: number };
  opportunities: SavingsOpportunity[];
  opportunityMonthlyTotal: number;
  cashFlow: { monthlyIncome: number | null; savingsRatePercent: number | null; spendToIncomePercent: number | null; stress: "none" | "elevated" | "deficit" | "unknown"; note: string };
  limitations: string[];
}

export const monthKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const prevMonthKey = (key: string): string => {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const normMerchant = (m: string | null): string => (m ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const severityOf = (z: number): Severity => (Math.abs(z) >= 7 ? "high" : Math.abs(z) >= 5 ? "medium" : "low");

export interface AnalyzeOptions {
  now?: Date;
  monthlyIncome?: number | null;
}

export function analyzeSpending(transactions: readonly SpendingTx[], options: AnalyzeOptions = {}): SpendingReport {
  const now = options.now ?? new Date();
  const current = monthKey(now);
  const previous = prevMonthKey(current);
  const txs = transactions.filter((t) => Number.isFinite(t.amount) && t.amount > 0);
  const limitations: string[] = [];

  // --- monthly totals ---
  const byMonth = new Map<string, SpendingTx[]>();
  for (const t of txs) byMonth.set(monthKey(t.date), [...(byMonth.get(monthKey(t.date)) ?? []), t]);
  const months = [...byMonth.keys()].sort();
  const monthlyTotals = months.map((m) => ({ month: m, total: sumMoney((byMonth.get(m) ?? []).map((t) => t.amount)), complete: m < current }));
  const completeTotals = monthlyTotals.filter((m) => m.complete).map((m) => m.total);
  const totalOf = (m: string) => monthlyTotals.find((x) => x.month === m)?.total ?? 0;
  const currentTotal = totalOf(current);
  const previousTotal = totalOf(previous);
  const averageMonthly = completeTotals.length >= MIN_MONTHS_FOR_AVERAGE ? round2(mean(completeTotals)) : null;
  const medianMonthly = completeTotals.length >= MIN_MONTHS_FOR_AVERAGE ? round2(median(completeTotals)) : null;
  if (completeTotals.length < MIN_MONTHS_FOR_AVERAGE) limitations.push(`Only ${completeTotals.length} complete month(s) of spending are recorded, so averages and trends are not reliable yet.`);

  // --- categories ---
  const categoryNames = [...new Set(txs.map((t) => t.category))];
  const typeOf = new Map(txs.map((t) => [t.category, t.categoryType] as const));
  const catMonthTotal = (cat: string, m: string) => sumMoney((byMonth.get(m) ?? []).filter((t) => t.category === cat).map((t) => t.amount));
  const completeMonthKeys = monthlyTotals.filter((m) => m.complete).map((m) => m.month);
  const categories: CategoryLine[] = categoryNames
    .map((cat) => {
      const cur = catMonthTotal(cat, current);
      const prev = catMonthTotal(cat, previous);
      const earlier = completeMonthKeys.map((m) => catMonthTotal(cat, m));
      return {
        category: cat,
        type: typeOf.get(cat) ?? "WANT",
        current: cur,
        previous: prev,
        changePercent: percentChange(cur, prev),
        typicalMonthly: earlier.length >= MIN_PRIOR_MONTHS_FOR_SPIKE ? round2(median(earlier)) : null,
        sharePercent: ratioPercent(cur, currentTotal),
      };
    })
    .filter((c) => c.current > 0 || c.previous > 0)
    .sort((a, b) => b.current - a.current);

  const currentTxs = byMonth.get(current) ?? [];
  const essentialTotal = sumMoney(currentTxs.filter((t) => t.categoryType === "NEED").map((t) => t.amount));
  const discretionaryTotal = sumMoney(currentTxs.filter((t) => t.categoryType === "WANT").map((t) => t.amount));
  const savingsTypeTotal = sumMoney(currentTxs.filter((t) => t.categoryType === "SAVINGS").map((t) => t.amount));

  const largest = [...currentTxs].sort((a, b) => b.amount - a.amount).slice(0, 5).map((t) => ({ id: t.id, date: t.date.toISOString().slice(0, 10), merchant: t.merchant, category: t.category, amount: t.amount }));

  // --- recurring / subscriptions ---
  const recurring = detectRecurring(txs);
  const recurringMonthlyTotal = sumMoney(recurring.map((r) => r.monthlyCost));

  // --- anomalies (only where there is enough history to judge) ---
  const anomalies: SpendingAnomaly[] = [];
  let categoriesEvaluated = 0;
  for (const cat of categoryNames) {
    const inCat = txs.filter((t) => t.category === cat);
    if (inCat.length < MIN_TX_FOR_CATEGORY_BASELINE) continue;
    categoriesEvaluated += 1;
    const amounts = inCat.map((t) => t.amount);
    const typical = round2(median(amounts));
    for (const t of inCat) {
      const z = robustZ(t.amount, amounts);
      if (z >= ROBUST_Z_THRESHOLD) {
        anomalies.push({
          kind: "transaction",
          subject: t.merchant || cat,
          transactionId: t.id,
          date: t.date.toISOString().slice(0, 10),
          category: cat,
          actual: t.amount,
          expected: typical,
          difference: round2(t.amount - typical),
          zScore: round2(z),
          method: "transaction_robust_z",
          severity: severityOf(z),
          explanation: `${round2(t.amount / (typical || 1))}x the median ${cat} transaction (${inCat.length} transactions compared).`,
        });
      }
    }
  }
  let seriesEvaluated = 0;
  for (const c of categories) {
    const earlier = completeMonthKeys.filter((m) => m !== current).map((m) => catMonthTotal(c.category, m));
    if (earlier.length < MIN_PRIOR_MONTHS_FOR_SPIKE || c.current <= 0) continue;
    seriesEvaluated += 1;
    const typical = round2(median(earlier));
    // Earlier months identical to the rupee give no spread to measure against: any rise of 50%+ is then treated as a spike (z capped at 10).
    const flat = earlier.every((v) => v === earlier[0]);
    const z = flat ? (c.current >= typical * 1.5 ? 10 : 0) : robustZ(c.current, earlier);
    if (z >= ROBUST_Z_THRESHOLD && c.current > typical) {
      anomalies.push({
        kind: "category_spike",
        subject: c.category,
        category: c.category,
        actual: c.current,
        expected: typical,
        difference: round2(c.current - typical),
        zScore: round2(z),
        method: "category_month_robust_z",
        severity: severityOf(z),
        explanation: `This month's ${c.category} spending is above its usual monthly level across ${earlier.length} earlier months.`,
      });
    }
  }
  anomalies.sort((a, b) => b.zScore - a.zScore);
  const evaluatedAnything = categoriesEvaluated > 0 || seriesEvaluated > 0;
  if (!evaluatedAnything) limitations.push(`No category has ${MIN_TX_FOR_CATEGORY_BASELINE}+ transactions or ${MIN_PRIOR_MONTHS_FOR_SPIKE}+ complete months of history, so unusual-spending detection could not be run. This is a data limitation, not a finding that nothing is unusual.`);
  else if (categoriesEvaluated < categoryNames.length) limitations.push(`Unusual-transaction checks covered ${categoriesEvaluated} of ${categoryNames.length} categories; the rest have too few transactions to judge.`);

  // --- savings opportunities (each says how it was derived) ---
  const opportunities: SavingsOpportunity[] = [];
  for (const c of categories) {
    if (c.type === "WANT" && c.typicalMonthly !== null && c.current > c.typicalMonthly) {
      opportunities.push({ label: `Bring ${c.category} back to your usual month`, monthlyAmount: round2(c.current - c.typicalMonthly), basis: `this month minus your median month for ${c.category}` });
    }
  }
  if (recurringMonthlyTotal > 0) {
    opportunities.push({ label: "Review recurring payments and subscriptions", monthlyAmount: recurringMonthlyTotal, basis: "upper bound: total of detected recurring payments; only what you choose to cancel would be saved" });
  }
  const opportunityMonthlyTotal = sumMoney(opportunities.filter((o) => !o.label.startsWith("Review recurring")).map((o) => o.monthlyAmount));

  // --- cash flow ---
  const income = options.monthlyIncome ?? null;
  let cashFlow: SpendingReport["cashFlow"];
  if (income === null || income <= 0) {
    cashFlow = { monthlyIncome: null, savingsRatePercent: null, spendToIncomePercent: null, stress: "unknown", note: "No income is recorded for this month, so savings rate and cash-flow stress cannot be calculated." };
    limitations.push("No income recorded this month, so cash-flow stress and savings rate were not assessed.");
  } else {
    const spendRatio = ratioPercent(currentTotal, income);
    const savingsRate = round2(100 - (spendRatio ?? 0));
    const stress: "none" | "elevated" | "deficit" = currentTotal > income ? "deficit" : (spendRatio ?? 0) >= 80 ? "elevated" : "none";
    cashFlow = {
      monthlyIncome: income,
      savingsRatePercent: savingsRate,
      spendToIncomePercent: spendRatio,
      stress,
      note: stress === "deficit" ? "Spending is higher than income this month." : stress === "elevated" ? "Spending is 80% or more of income this month, leaving little room for saving." : "Spending is below 80% of income this month.",
    };
  }

  return {
    asOf: now.toISOString(),
    currentMonth: current,
    previousMonth: previous,
    monthlyTotals,
    currentTotal,
    previousTotal,
    changePercent: percentChange(currentTotal, previousTotal),
    averageMonthly,
    medianMonthly,
    completeMonthsUsed: completeTotals.length,
    categories,
    essentialTotal,
    discretionaryTotal,
    savingsTypeTotal,
    largest,
    recurring,
    recurringMonthlyTotal,
    anomalies,
    anomalyStatus: evaluatedAnything ? "evaluated" : "insufficient_history",
    anomalyCoverage: { categoriesEvaluated, categoriesTotal: categoryNames.length, categorySeriesEvaluated: seriesEvaluated },
    opportunities,
    opportunityMonthlyTotal,
    cashFlow,
    limitations,
  };
}

/** Merchants charged in at least three different months for nearly the same amount, plus anything the user flagged as recurring. */
export function detectRecurring(txs: readonly SpendingTx[]): RecurringItem[] {
  const groups = new Map<string, SpendingTx[]>();
  for (const t of txs) {
    const key = normMerchant(t.merchant);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const items: RecurringItem[] = [];
  for (const [key, list] of groups) {
    const distinctMonths = new Set(list.map((t) => monthKey(t.date)));
    const flagged = list.some((t) => t.isRecurring);
    const amounts = list.map((t) => t.amount);
    const cv = coefficientOfVariation(amounts);
    const pattern = distinctMonths.size >= MIN_OCCURRENCES_FOR_RECURRING && cv !== null && cv <= RECURRING_MAX_CV;
    if (!flagged && !pattern) continue;
    const typical = round2(median(amounts));
    // One charge per month is the working assumption for a monthly cost; the figure is a typical charge, not a total.
    items.push({ merchant: list[0].merchant ?? key, category: list[0].category, typicalAmount: typical, occurrences: list.length, monthlyCost: typical, basis: flagged ? "flagged_recurring" : "detected_pattern" });
  }
  return items.sort((a, b) => b.monthlyCost - a.monthlyCost);
}

/** Groups transactions that share merchant, amount and day: likely double entries. */
export function findPossibleDuplicates(txs: readonly SpendingTx[]): { merchant: string | null; amount: number; date: string; count: number; ids: string[] }[] {
  const groups = new Map<string, SpendingTx[]>();
  for (const t of txs) {
    const key = `${normMerchant(t.merchant)}|${t.amount.toFixed(2)}|${t.date.toISOString().slice(0, 10)}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => ({ merchant: g[0].merchant, amount: g[0].amount, date: g[0].date.toISOString().slice(0, 10), count: g.length, ids: g.map((t) => t.id) }));
}
