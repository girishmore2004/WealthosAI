import { formatMoney } from "./financial-verification";
import { SpendingReport } from "./spending-intelligence";

const row = (...cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;
const signed = (n: number | null): string => (n === null ? "n/a" : `${n > 0 ? "+" : ""}${n}%`);
const klass = (t: string): string => (t === "NEED" ? "essential" : t === "WANT" ? "discretionary" : "savings");

export function renderSpending(r: SpendingReport): string {
  const out: string[] = ["## Spending analysis"];

  out.push("\n### 1. Actual monthly spending");
  out.push(`This month (${r.currentMonth}): ${formatMoney(r.currentTotal)}. Last month (${r.previousMonth}): ${formatMoney(r.previousTotal)} (${signed(r.changePercent)}).`);
  if (r.averageMonthly !== null && r.medianMonthly !== null) out.push(`Across ${r.completeMonthsUsed} complete months: average ${formatMoney(r.averageMonthly)}, median ${formatMoney(r.medianMonthly)}.`);
  out.push(`Essential ${formatMoney(r.essentialTotal)} · discretionary ${formatMoney(r.discretionaryTotal)} this month.`);

  out.push("\n### 2. Category breakdown and historical comparison");
  if (r.categories.length === 0) out.push("No spending is recorded for this or last month.");
  else {
    out.push(row("Category", "Type", "This month", "Share", "Last month", "Change", "Usual month (median)"), row("---", "---", "---:", "---:", "---:", "---:", "---:"));
    for (const c of r.categories.slice(0, 12)) out.push(row(c.category, klass(c.type), formatMoney(c.current), c.sharePercent === null ? "n/a" : `${c.sharePercent}%`, formatMoney(c.previous), signed(c.changePercent), c.typicalMonthly === null ? "not enough history" : formatMoney(c.typicalMonthly)));
  }

  out.push("\n### 3. Largest transactions this month");
  if (r.largest.length === 0) out.push("None recorded.");
  else {
    out.push(row("Date", "Merchant", "Category", "Amount"), row("---", "---", "---", "---:"));
    for (const t of r.largest) out.push(row(t.date, t.merchant ?? "—", t.category, formatMoney(t.amount)));
  }

  out.push("\n### 4. Anomalies");
  if (r.anomalyStatus === "insufficient_history") {
    out.push("Unusual-spending detection could not be run: there is not enough history in any category. This is a data limitation, not a finding that nothing is unusual.");
  } else {
    out.push(`Checked ${r.anomalyCoverage.categoriesEvaluated} of ${r.anomalyCoverage.categoriesTotal} categories for unusual transactions and ${r.anomalyCoverage.categorySeriesEvaluated} category(ies) for month-level spikes (modified z-score from median absolute deviation, threshold 3.5).`);
    if (r.anomalies.length === 0) out.push("Nothing exceeded the threshold in the data that could be evaluated.");
    else {
      out.push(row("What", "Date", "Actual", "Expected", "Difference", "Method", "Severity", "Why"), row("---", "---", "---:", "---:", "---:", "---", "---", "---"));
      for (const a of r.anomalies.slice(0, 10)) out.push(row(a.kind === "transaction" ? `${a.subject} (${a.category})` : `${a.category} (month total)`, a.date ?? "this month", formatMoney(a.actual), formatMoney(a.expected), formatMoney(a.difference), a.method === "transaction_robust_z" ? "robust z-score vs category median" : "robust z-score vs earlier months", `${a.severity} (z ${a.zScore})`, a.explanation));
    }
  }

  out.push("\n### 5. Recurring payments and subscriptions");
  if (r.recurring.length === 0) out.push("No recurring payments were flagged or detected.");
  else {
    out.push(`About ${formatMoney(r.recurringMonthlyTotal)} a month.`);
    out.push(row("Merchant", "Category", "Typical charge", "Times seen", "Found by"), row("---", "---", "---:", "---:", "---"));
    for (const x of r.recurring.slice(0, 10)) out.push(row(x.merchant, x.category, formatMoney(x.typicalAmount), x.occurrences, x.basis === "flagged_recurring" ? "your recurring flag" : "same amount in 3+ months"));
  }

  out.push("\n### 6. Cash flow and savings rate");
  out.push(r.cashFlow.note);
  if (r.cashFlow.monthlyIncome !== null) out.push(`Income ${formatMoney(r.cashFlow.monthlyIncome)}; spending is ${r.cashFlow.spendToIncomePercent}% of it; savings rate ${r.cashFlow.savingsRatePercent}%.`);

  out.push("\n### 7. Savings opportunities");
  if (r.opportunities.length === 0) out.push("No quantified opportunities: no discretionary category is above its own usual month, and no recurring payments were found.");
  else {
    out.push(row("Opportunity", "Monthly amount", "How it was calculated"), row("---", "---:", "---"));
    for (const o of r.opportunities) out.push(row(o.label, formatMoney(o.monthlyAmount), o.basis));
    if (r.opportunityMonthlyTotal > 0) out.push(`Total from categories above your usual month: ${formatMoney(r.opportunityMonthlyTotal)} a month. The recurring-payments line is an upper bound and is not included in that total.`);
  }

  if (r.limitations.length > 0) out.push("\n### Limitations\n" + r.limitations.map((l) => `- ${l}`).join("\n"));
  return out.join("\n");
}
