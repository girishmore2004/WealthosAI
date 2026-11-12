import { annualise, monthlyEquivalent, percentChange, ratioPercent, round2, sumMoney } from "./financial-math";
import { formatMoney } from "./financial-verification";
import { SpendClass, SpendingReport, SpendingTx, analyzeSpending, findPossibleDuplicates, monthKey } from "./spending-intelligence";

// Pure construction of the complete financial audit from already-fetched data. The service fetches every domain in
// parallel and hands each result (or its failure) here, so this file decides one thing for each domain: what status it
// had, and what can honestly be said. A domain that was not fetched or failed is NEVER reported as "no data".

export type Fetched<T> = { ok: true; data: T } | { ok: false; error: string };

export const DOMAIN_KEYS = ["income", "expenses", "transactions", "savings", "investments", "sips", "loans", "insurance", "goals", "recurring", "dataHealth"] as const;
export type DomainKey = (typeof DOMAIN_KEYS)[number];
export type DomainStatus = "retrieved" | "partial" | "no_records" | "failed" | "not_supported";

export const DOMAIN_STATUS_LABEL: Record<DomainStatus, string> = {
  retrieved: "Retrieved successfully",
  partial: "Partially retrieved",
  no_records: "No records found",
  failed: "Retrieval failed",
  not_supported: "Not supported by current application",
};

export interface DomainReport {
  domain: DomainKey;
  title: string;
  status: DomainStatus;
  records: number;
  detail: string; // one line: why this status
  unsupported: string[]; // parts of the domain the application does not track
  error?: string;
}

export interface IncomeRow { label: string; source: string; amount: number; recurrence: string; receivedAt: Date; recurrenceActive: boolean }
export interface ExpenseRow extends SpendingTx { paymentMethod: string }
export interface InvestmentRow { id: string; name: string; type: string; currentValue: number; costBasis: number; riskLevel: string; sipActive: boolean; sipPaused: boolean; sipCancelled: boolean; monthlyContribution: number | null; contributionFrequency: string; contributionDay: number | null; contributionStartDate: Date | null; contributions12m: number; contributionCount12m: number }
export interface LoanRow { lender: string; type: string; principal: number; outstanding: number; ratePercent: number; tenureMonths: number; emi: number; startDate: Date }
export interface PolicyRow { id: string; provider: string; type: string; premiumAmount: number; frequency: string; coverage: number; renewalDate: Date; recordedCount: number; recordedPaid: number }
export interface GoalRow { name: string; type: string; target: number; current: number; deadline: Date; monthlyContribution: number; archived: boolean }
export interface DataIssue { code: string; severity: string; message: string; count: number }
export interface DiscrepancyRow { documentName: string; entityType: string; field: string; documentValue: string; databaseValue: string; status: string; createdAt: Date }

export interface CashFlowFacts { income: number; expenses: number; investmentContributions: number; emergencyAllocations: number; netCashFlow: number; savingsRatePercent: number | null }
export interface NetWorthFacts { availableCash: number; emergencyCash: number; totalCash: number; investmentValue: number; loans: number; totalAssets: number; totalLiabilities: number; netWorth: number }
export interface EmergencyFacts { balance: number; coverageMonths: number | null; targetAmount: number | null; avgMonthlyEssentialExpenses: number | null }

export interface AuditInputs {
  asOf: Date;
  cashFlow: Fetched<CashFlowFacts>;
  netWorth: Fetched<NetWorthFacts>;
  emergency: Fetched<EmergencyFacts>;
  incomeRows: Fetched<IncomeRow[]>;
  expenseRows: Fetched<ExpenseRow[]>;
  investments: Fetched<InvestmentRow[]>;
  loans: Fetched<LoanRow[]>;
  policies: Fetched<PolicyRow[]>;
  goals: Fetched<GoalRow[]>;
  recurringIncomeCount: Fetched<number>;
  dataHealth: Fetched<DataIssue[]>;
  discrepancies: Fetched<DiscrepancyRow[]>;
}

export interface InsuranceReconciliation {
  listedPremiumSum: number;
  annualisedPremiumTotal: number;
  recordedPaidTotal: number;
  policiesNeedingReview: { policy: string; reason: string }[];
  note: string;
}

export interface AuditSnapshot {
  monthlyIncome: number | null;
  monthlyExpenses: number | null;
  savingsRatePercent: number | null;
  netCashFlow: number | null;
  emergencyFund: EmergencyFacts | null;
  netWorth: NetWorthFacts | null;
  investmentValue: number | null;
  activeSipMonthly: number | null;
  loans: { totalOutstanding: number; totalEmi: number; items: LoanRow[] } | null;
  insurance: { policies: PolicyRow[]; annualPremium: number; healthCover: number; termCover: number; reconciliation: InsuranceReconciliation } | null;
  goals: GoalRow[] | null;
  spending: SpendingReport | null;
}

export interface FinancialAudit {
  asOf: string;
  domains: DomainReport[];
  snapshot: AuditSnapshot;
  risks: string[];
  opportunities: string[];
  dataQuality: string[];
  warnings: string[];
  markdown: string;
}

const failure = <T>(f: Fetched<T>): string | null => (f.ok ? null : f.error);

function status(fetchedFailed: boolean, records: number, partial: boolean): DomainStatus {
  if (fetchedFailed) return "failed";
  if (records === 0) return "no_records";
  return partial ? "partial" : "retrieved";
}

export function buildFinancialAudit(inputs: AuditInputs): FinancialAudit {
  const now = inputs.asOf;
  const warnings: string[] = [];
  const risks: string[] = [];
  const opportunities: string[] = [];
  const dataQuality: string[] = [];
  const domains: DomainReport[] = [];
  const add = (r: DomainReport) => domains.push(r);

  // ---------------- derived from the cash-flow facts ----------------
  const cf = inputs.cashFlow.ok ? inputs.cashFlow.data : null;
  const nw = inputs.netWorth.ok ? inputs.netWorth.data : null;
  const em = inputs.emergency.ok ? inputs.emergency.data : null;

  // ---------------- income ----------------
  const incomeRows = inputs.incomeRows.ok ? inputs.incomeRows.data : [];
  const monthlyIncome = cf ? cf.income : null;
  const bySource = new Map<string, number>();
  const incomeByMonth = new Map<string, number>();
  for (const r of incomeRows) {
    bySource.set(r.source, round2((bySource.get(r.source) ?? 0) + r.amount));
    incomeByMonth.set(monthKey(r.receivedAt), round2((incomeByMonth.get(monthKey(r.receivedAt)) ?? 0) + r.amount));
  }
  const nonSalary = sumMoney([...bySource.entries()].filter(([s]) => s !== "SALARY").map(([, v]) => v));
  const incomeFailed = !inputs.incomeRows.ok;
  add({
    domain: "income",
    title: "Income",
    status: incomeFailed ? "failed" : incomeRows.length === 0 ? "no_records" : cf ? "retrieved" : "partial",
    records: incomeRows.length,
    detail: incomeFailed ? "Income records could not be read." : incomeRows.length === 0 ? "No income entries in the last 12 months." : cf ? `${incomeRows.length} income entries in the last 12 months; this month's income comes from the cash-flow ledger.` : "Income entries were read, but this month's cash-flow figure failed.",
    unsupported: [],
    error: failure(inputs.incomeRows) ?? undefined,
  });

  // ---------------- expenses + transactions ----------------
  const expenseRows = inputs.expenseRows.ok ? inputs.expenseRows.data : [];
  const spending = inputs.expenseRows.ok ? analyzeSpending(expenseRows, { now, monthlyIncome }) : null;
  add({
    domain: "expenses",
    title: "Expenses",
    status: status(!inputs.expenseRows.ok, expenseRows.length, !cf),
    records: expenseRows.length,
    detail: !inputs.expenseRows.ok ? "Expense records could not be read." : expenseRows.length === 0 ? "No expenses in the last 6 months." : `${expenseRows.length} expenses over the last 6 months, grouped by category.`,
    unsupported: [],
    error: failure(inputs.expenseRows) ?? undefined,
  });
  const duplicates = inputs.expenseRows.ok ? findPossibleDuplicates(expenseRows) : [];
  const uncategorised = expenseRows.filter((t) => /^(uncategori[sz]ed|unknown|misc(ellaneous)?|other)$/i.test(t.category.trim()));
  add({
    domain: "transactions",
    title: "Transactions",
    status: status(!inputs.expenseRows.ok, expenseRows.length, false),
    records: expenseRows.length,
    detail: !inputs.expenseRows.ok ? "Transaction history could not be read." : expenseRows.length === 0 ? "No transactions in the last 6 months." : `${expenseRows.length} transactions; ${duplicates.length} possible duplicate group(s); ${uncategorised.length} in a generic category.`,
    unsupported: [],
    error: failure(inputs.expenseRows) ?? undefined,
  });
  if (duplicates.length > 0) dataQuality.push(`${duplicates.length} group(s) of transactions share the same merchant, amount and date and may be double entries (${duplicates.slice(0, 3).map((d) => `${d.merchant ?? "unnamed"} ${formatMoney(d.amount)} on ${d.date} ×${d.count}`).join("; ")}).`);
  if (uncategorised.length > 0) dataQuality.push(`${uncategorised.length} transaction(s) sit in a generic category such as "Other", which weakens category analysis.`);

  // ---------------- savings ----------------
  const savingsRate = cf?.savingsRatePercent ?? null;
  const savingsFailed = !inputs.cashFlow.ok && !inputs.netWorth.ok && !inputs.emergency.ok;
  const savingsPartial = !inputs.cashFlow.ok || !inputs.netWorth.ok || !inputs.emergency.ok;
  add({
    domain: "savings",
    title: "Savings",
    status: savingsFailed ? "failed" : savingsPartial ? "partial" : "retrieved",
    records: [cf, nw, em].filter(Boolean).length,
    detail: savingsFailed ? "Cash-flow, cash-position and emergency-fund figures all failed to load." : savingsPartial ? "Some savings figures failed to load (see warnings)." : "Monthly savings, savings rate, cash position and emergency fund loaded.",
    unsupported: ["bank or savings-account balances held outside WealthOS (only the cash position derived from your ledger is available)"],
    error: savingsFailed ? failure(inputs.cashFlow) ?? undefined : undefined,
  });
  if (!inputs.cashFlow.ok) warnings.push("This month's cash-flow figures could not be loaded, so savings rate and net cash flow are not shown.");
  if (!inputs.netWorth.ok) warnings.push("Net worth and cash position could not be loaded.");
  if (!inputs.emergency.ok) warnings.push("Emergency-fund figures could not be loaded.");

  // ---------------- investments & SIPs ----------------
  const invs = inputs.investments.ok ? inputs.investments.data : [];
  const invested = sumMoney(invs.map((i) => i.costBasis));
  const currentValue = sumMoney(invs.map((i) => i.currentValue));
  const allocation = new Map<string, number>();
  for (const i of invs) allocation.set(i.type, round2((allocation.get(i.type) ?? 0) + i.currentValue));
  add({
    domain: "investments",
    title: "Investments",
    status: status(!inputs.investments.ok, invs.length, false),
    records: invs.length,
    detail: !inputs.investments.ok ? "Investment holdings could not be read." : invs.length === 0 ? "No investment holdings recorded." : `${invs.length} holdings; current value uses the latest recorded valuation of each.`,
    unsupported: ["time-weighted or XIRR returns (only cost-basis versus current-value gain is shown)"],
    error: failure(inputs.investments) ?? undefined,
  });
  const sips = invs.filter((i) => i.sipActive && !i.sipCancelled && !i.sipPaused && (i.monthlyContribution ?? 0) > 0);
  const sipMonthly = sumMoney(sips.map((s) => monthlyEquivalent(s.monthlyContribution ?? 0, s.contributionFrequency) ?? 0));
  add({
    domain: "sips",
    title: "SIPs",
    status: status(!inputs.investments.ok, sips.length, false),
    records: sips.length,
    detail: !inputs.investments.ok ? "SIP details could not be read." : sips.length === 0 ? "No active SIPs recorded." : `${sips.length} active SIP(s) with contributions recorded over the last 12 months.`,
    unsupported: [],
    error: failure(inputs.investments) ?? undefined,
  });
  const stale = invs.filter((i) => i.currentValue === 0 && i.costBasis > 0);
  if (stale.length > 0) dataQuality.push(`${stale.length} holding(s) have a cost basis but a current value of zero (${stale.slice(0, 3).map((s) => s.name).join(", ")}); their value may be missing.`);

  // ---------------- loans ----------------
  const loans = inputs.loans.ok ? inputs.loans.data : [];
  const totalOutstanding = sumMoney(loans.map((l) => l.outstanding));
  const totalEmi = sumMoney(loans.map((l) => l.emi));
  add({
    domain: "loans",
    title: "Loans",
    status: status(!inputs.loans.ok, loans.length, false),
    records: loans.length,
    detail: !inputs.loans.ok ? "Loans could not be read." : loans.length === 0 ? "No loans recorded." : `${loans.length} loan(s) with outstanding principal, EMI and rate.`,
    unsupported: ["remaining tenure is estimated from the start date and tenure, not read from a lender statement"],
    error: failure(inputs.loans) ?? undefined,
  });

  // ---------------- insurance ----------------
  const policies = inputs.policies.ok ? inputs.policies.data : [];
  const insurance = policies.length > 0 ? reconcileInsurance(policies) : null;
  add({
    domain: "insurance",
    title: "Insurance",
    status: status(!inputs.policies.ok, policies.length, false),
    records: policies.length,
    detail: !inputs.policies.ok ? "Insurance policies could not be read." : policies.length === 0 ? "No insurance policies recorded." : `${policies.length} polic${policies.length === 1 ? "y" : "ies"} with insurer, cover, premium, frequency and renewal date.`,
    unsupported: [],
    error: failure(inputs.policies) ?? undefined,
  });
  if (insurance) for (const p of insurance.policiesNeedingReview) dataQuality.push(`Insurance "${p.policy}": ${p.reason}`);

  // ---------------- goals ----------------
  const goals = inputs.goals.ok ? inputs.goals.data.filter((g) => !g.archived) : [];
  add({
    domain: "goals",
    title: "Goals",
    status: status(!inputs.goals.ok, goals.length, false),
    records: goals.length,
    detail: !inputs.goals.ok ? "Goals could not be read." : goals.length === 0 ? "No active goals recorded." : `${goals.length} active goal(s) with target, progress and deadline.`,
    unsupported: [],
    error: failure(inputs.goals) ?? undefined,
  });

  // ---------------- recurring ----------------
  const recurringExpenses = spending?.recurring ?? [];
  const recurringIncome = inputs.recurringIncomeCount.ok ? inputs.recurringIncomeCount.data : 0;
  const recurringFailed = !inputs.expenseRows.ok;
  add({
    domain: "recurring",
    title: "Recurring payments",
    status: recurringFailed ? "failed" : recurringExpenses.length === 0 ? "no_records" : "partial",
    records: recurringExpenses.length,
    detail: recurringFailed ? "Expense history needed to find recurring payments could not be read." : recurringExpenses.length === 0 ? "No recurring payments flagged or detected." : `${recurringExpenses.length} recurring payment(s) found from your flags and repeat patterns.`,
    unsupported: ["next payment dates for detected (unflagged) recurring payments, and bills not entered as expenses"],
    error: failure(inputs.expenseRows) ?? undefined,
  });

  // ---------------- data health ----------------
  const issues = inputs.dataHealth.ok ? inputs.dataHealth.data : [];
  const discrepancies = inputs.discrepancies.ok ? inputs.discrepancies.data : [];
  const healthFailed = !inputs.dataHealth.ok && !inputs.discrepancies.ok;
  add({
    domain: "dataHealth",
    title: "Data health",
    status: healthFailed ? "failed" : !inputs.dataHealth.ok || !inputs.discrepancies.ok ? "partial" : "retrieved",
    records: issues.length + discrepancies.length,
    detail: healthFailed ? "Data-health checks could not be run." : `${issues.length} data-health finding(s) and ${discrepancies.length} document discrepancy record(s).`,
    unsupported: [],
    error: healthFailed ? failure(inputs.dataHealth) ?? undefined : undefined,
  });
  for (const i of issues.filter((x) => x.severity !== "INFO")) dataQuality.push(i.message);
  const openDisc = discrepancies.filter((d) => d.status === "OPEN");
  if (openDisc.length > 0) dataQuality.push(`${openDisc.length} open difference(s) between your records and uploaded documents need your review; nothing was overwritten.`);

  // ---------------- risks & opportunities (rule-based, all from the data above) ----------------
  if (monthlyIncome !== null && monthlyIncome > 0 && cf) {
    if (cf.expenses > monthlyIncome) risks.push(`Spending (${formatMoney(cf.expenses)}) exceeds income (${formatMoney(monthlyIncome)}) this month.`);
    else if (savingsRate !== null && savingsRate < 10) risks.push(`Savings rate is ${savingsRate}% this month, below 10%.`);
    if (totalEmi > 0) {
      const dti = ratioPercent(totalEmi, monthlyIncome);
      if (dti !== null && dti >= 40) risks.push(`EMIs take ${dti}% of this month's income (${formatMoney(totalEmi)} of ${formatMoney(monthlyIncome)}).`);
    }
  }
  if (em && em.coverageMonths !== null && em.coverageMonths < 3) risks.push(`Emergency fund covers ${em.coverageMonths} months of essential expenses.`);
  if (policies.length > 0 && !policies.some((p) => p.type === "HEALTH")) risks.push("No health insurance policy is recorded.");
  if (policies.length === 0 && inputs.policies.ok) risks.push("No insurance policies are recorded.");
  const behind = goals.filter((g) => monthsUntil(g.deadline, now) > 0 && g.current < g.target && requiredMonthly(g, now) > g.monthlyContribution + 1);
  for (const g of behind.slice(0, 3)) risks.push(`Goal "${g.name}" needs about ${formatMoney(requiredMonthly(g, now))}/month to be on time but is set to ${formatMoney(g.monthlyContribution)}/month.`);
  for (const o of spending?.opportunities ?? []) opportunities.push(`${o.label}: about ${formatMoney(o.monthlyAmount)}/month (${o.basis}).`);
  if (sips.length === 0 && cf && cf.netCashFlow > 0 && inputs.investments.ok) opportunities.push(`You have a positive net cash flow of ${formatMoney(cf.netCashFlow)} this month and no active SIP.`);

  const snapshot: AuditSnapshot = {
    monthlyIncome,
    monthlyExpenses: cf?.expenses ?? null,
    savingsRatePercent: savingsRate,
    netCashFlow: cf?.netCashFlow ?? null,
    emergencyFund: em,
    netWorth: nw,
    investmentValue: inputs.investments.ok ? currentValue : nw?.investmentValue ?? null,
    activeSipMonthly: inputs.investments.ok ? sipMonthly : null,
    loans: inputs.loans.ok ? { totalOutstanding, totalEmi, items: loans } : null,
    insurance: insurance
      ? {
          policies,
          annualPremium: insurance.annualisedPremiumTotal,
          healthCover: sumMoney(policies.filter((p) => p.type === "HEALTH").map((p) => p.coverage)),
          termCover: sumMoney(policies.filter((p) => p.type === "TERM").map((p) => p.coverage)),
          reconciliation: insurance,
        }
      : null,
    goals: inputs.goals.ok ? goals : null,
    spending,
  };

  const audit: FinancialAudit = { asOf: now.toISOString(), domains, snapshot, risks, opportunities, dataQuality, warnings, markdown: "" };
  audit.markdown = renderAudit(audit, { incomeRows, bySource, incomeByMonth, nonSalary, invs, invested, currentValue, allocation, sips, sipMonthly, loans, totalOutstanding, totalEmi, policies, insurance, goals, recurringIncome, issues, discrepancies, duplicates });
  return audit;
}

export function monthsUntil(date: Date, now: Date): number {
  return (date.getUTCFullYear() - now.getUTCFullYear()) * 12 + (date.getUTCMonth() - now.getUTCMonth());
}

export function requiredMonthly(g: GoalRow, now: Date): number {
  const months = Math.max(1, monthsUntil(g.deadline, now));
  return round2(Math.max(0, g.target - g.current) / months);
}

export function reconcileInsurance(policies: readonly PolicyRow[]): InsuranceReconciliation {
  const listedPremiumSum = sumMoney(policies.map((p) => p.premiumAmount));
  const annualisedPremiumTotal = sumMoney(policies.map((p) => annualise(p.premiumAmount, p.frequency) ?? 0));
  const recordedPaidTotal = sumMoney(policies.map((p) => p.recordedPaid));
  const needing: { policy: string; reason: string }[] = [];
  for (const p of policies) {
    const name = `${p.provider} ${p.type.toLowerCase().replace(/_/g, " ")}`;
    if (annualise(p.premiumAmount, p.frequency) === null) needing.push({ policy: name, reason: `premium frequency "${p.frequency}" is not recognised, so its yearly cost is not included in the annual total.` });
    const expected = round2(p.premiumAmount * p.recordedCount);
    if (p.recordedCount > 0 && Math.abs(expected - p.recordedPaid) > 1) needing.push({ policy: name, reason: `${p.recordedCount} recorded payment(s) add up to ${formatMoney(p.recordedPaid)}, but ${p.recordedCount} × the current premium of ${formatMoney(p.premiumAmount)} is ${formatMoney(expected)}.` });
    if (p.renewalDate.getTime() < Date.now() - 86_400_000) needing.push({ policy: name, reason: `renewal date ${p.renewalDate.toISOString().slice(0, 10)} has passed; the policy may have lapsed or the date needs updating.` });
  }
  const diff = round2(recordedPaidTotal - listedPremiumSum);
  const note =
    Math.abs(diff) <= 1
      ? "Recorded payments and listed premium amounts agree."
      : `Listed premium amounts add up to ${formatMoney(listedPremiumSum)}, while recorded payments add up to ${formatMoney(recordedPaidTotal)} (difference ${formatMoney(Math.abs(diff))}). These measure different things — the first is each policy's current premium for one cycle, the second is what has been recorded as paid — so neither is a verified total of the other.`;
  return { listedPremiumSum, annualisedPremiumTotal, recordedPaidTotal, policiesNeedingReview: needing, note };
}

interface RenderCtx {
  incomeRows: IncomeRow[];
  bySource: Map<string, number>;
  incomeByMonth: Map<string, number>;
  nonSalary: number;
  invs: InvestmentRow[];
  invested: number;
  currentValue: number;
  allocation: Map<string, number>;
  sips: InvestmentRow[];
  sipMonthly: number;
  loans: LoanRow[];
  totalOutstanding: number;
  totalEmi: number;
  policies: PolicyRow[];
  insurance: InsuranceReconciliation | null;
  goals: GoalRow[];
  recurringIncome: number;
  issues: DataIssue[];
  discrepancies: DiscrepancyRow[];
  duplicates: ReturnType<typeof findPossibleDuplicates>;
}

const pct = (n: number | null): string => (n === null ? "n/a" : `${n}%`);
const row = (...cells: (string | number)[]): string => `| ${cells.join(" | ")} |`;
const titleCase = (s: string): string => s.toLowerCase().replace(/_/g, " ");
const cls = (t: SpendClass): string => (t === "NEED" ? "essential" : t === "WANT" ? "discretionary" : "savings");

function renderAudit(a: FinancialAudit, c: RenderCtx): string {
  const s = a.snapshot;
  const out: string[] = [];
  const failed = a.domains.filter((d) => d.status === "failed");
  const empty = a.domains.filter((d) => d.status === "no_records");

  out.push("## 1. Executive summary");
  const headline: string[] = [];
  if (s.monthlyIncome !== null && s.monthlyExpenses !== null) headline.push(`This month you earned ${formatMoney(s.monthlyIncome)} and spent ${formatMoney(s.monthlyExpenses)}${s.savingsRatePercent !== null ? `, a savings rate of ${s.savingsRatePercent}%` : ""}.`);
  if (s.netWorth) headline.push(`Net worth is ${formatMoney(s.netWorth.netWorth)} (assets ${formatMoney(s.netWorth.totalAssets)}, liabilities ${formatMoney(s.netWorth.totalLiabilities)}).`);
  if (headline.length === 0) headline.push("Core cash-flow figures could not be loaded, so no headline numbers are shown.");
  out.push(headline.join(" "));
  out.push(`Domains retrieved: ${a.domains.filter((d) => d.status === "retrieved").length} fully, ${a.domains.filter((d) => d.status === "partial").length} partly, ${empty.length} with no records, ${failed.length} failed.${failed.length > 0 ? ` Failed: ${failed.map((d) => d.title).join(", ")} — these are unknown, not empty.` : ""}`);
  if (a.risks.length > 0) out.push(`Top concerns: ${a.risks.slice(0, 3).join(" ")}`);

  out.push("\n## 2. Complete account overview — what was retrieved");
  out.push(row("Domain", "Status", "Records", "Notes"), row("---", "---", "---:", "---"));
  for (const d of a.domains) out.push(row(d.title, DOMAIN_STATUS_LABEL[d.status], d.records, [d.detail, ...d.unsupported.map((u) => `Not tracked: ${u}`)].join(" ")));

  out.push("\n## 3. Income analysis");
  if (s.monthlyIncome !== null) out.push(`Income recorded this month: ${formatMoney(s.monthlyIncome)}.`);
  if (c.incomeRows.length > 0) {
    out.push(`Income entries in the last 12 months: ${c.incomeRows.length}. Income outside salary: ${formatMoney(c.nonSalary)}.`);
    out.push(row("Source", "12-month total"), row("---", "---:"));
    for (const [src, v] of [...c.bySource.entries()].sort((x, y) => y[1] - x[1])) out.push(row(titleCase(src), formatMoney(v)));
    const months = [...c.incomeByMonth.entries()].sort().slice(-6);
    if (months.length > 0) out.push(`Recent monthly income history: ${months.map(([m, v]) => `${m} ${formatMoney(v)}`).join("; ")}.`);
    if (c.recurringIncome > 0) out.push(`${c.recurringIncome} income entr${c.recurringIncome === 1 ? "y is" : "ies are"} set to repeat automatically.`);
  } else out.push(statusLine(a, "income"));

  out.push("\n## 4. Expense analysis");
  if (s.spending && s.spending.categories.length > 0) {
    const sp = s.spending;
    out.push(`Spending this month: ${formatMoney(sp.currentTotal)}; last month: ${formatMoney(sp.previousTotal)}${sp.changePercent !== null ? ` (${sp.changePercent > 0 ? "+" : ""}${sp.changePercent}%)` : ""}.${sp.averageMonthly !== null ? ` Average of ${sp.completeMonthsUsed} complete months: ${formatMoney(sp.averageMonthly)}.` : ""}`);
    out.push(`Essential ${formatMoney(sp.essentialTotal)}, discretionary ${formatMoney(sp.discretionaryTotal)}${sp.savingsTypeTotal > 0 ? `, savings-type ${formatMoney(sp.savingsTypeTotal)}` : ""} this month.`);
    out.push(row("Category", "Type", "This month", "Last month", "Change"), row("---", "---", "---:", "---:", "---:"));
    for (const k of sp.categories.slice(0, 10)) out.push(row(k.category, cls(k.type), formatMoney(k.current), formatMoney(k.previous), k.changePercent === null ? "n/a" : `${k.changePercent > 0 ? "+" : ""}${k.changePercent}%`));
  } else out.push(statusLine(a, "expenses"));

  out.push("\n## 5. Transactions");
  if (s.spending && c.duplicates !== undefined) {
    const sp = s.spending;
    if (sp.largest.length > 0) {
      out.push("Largest transactions this month:");
      out.push(row("Date", "Merchant", "Category", "Amount"), row("---", "---", "---", "---:"));
      for (const t of sp.largest) out.push(row(t.date, t.merchant ?? "—", t.category, formatMoney(t.amount)));
    } else out.push("No transactions recorded this month.");
    out.push(c.duplicates.length > 0 ? `Possible duplicates: ${c.duplicates.length} group(s).` : "No same-day, same-merchant, same-amount duplicates found.");
  } else out.push(statusLine(a, "transactions"));

  out.push("\n## 6. Savings analysis");
  if (s.savingsRatePercent !== null || s.netCashFlow !== null) out.push(`Savings rate ${pct(s.savingsRatePercent)}; net cash flow this month ${s.netCashFlow === null ? "n/a" : formatMoney(s.netCashFlow)}.`);
  if (s.netWorth) out.push(`Cash position: available ${formatMoney(s.netWorth.availableCash)}, emergency reserve ${formatMoney(s.netWorth.emergencyCash)}, total ${formatMoney(s.netWorth.totalCash)}.`);
  if (s.emergencyFund) out.push(`Emergency fund: ${formatMoney(s.emergencyFund.balance)}${s.emergencyFund.coverageMonths !== null ? `, covering ${s.emergencyFund.coverageMonths} months of essential expenses` : ", coverage not calculable (no essential-expense history)"}${s.emergencyFund.targetAmount !== null ? `; target ${formatMoney(s.emergencyFund.targetAmount)}` : "; no target set"}.`);
  if (!s.netWorth && !s.emergencyFund && s.savingsRatePercent === null) out.push(statusLine(a, "savings"));

  out.push("\n## 7. Investment analysis");
  if (c.invs.length > 0) {
    const gain = round2(c.currentValue - c.invested);
    out.push(`Invested (cost basis) ${formatMoney(c.invested)}; current value ${formatMoney(c.currentValue)}; gain ${gain >= 0 ? "" : "−"}${formatMoney(Math.abs(gain))}${c.invested > 0 ? ` (${percentChange(c.currentValue, c.invested)}%)` : ""}. Simple gain only; no annualised return is claimed.`);
    out.push(row("Asset type", "Current value", "Share"), row("---", "---:", "---:"));
    for (const [t, v] of [...c.allocation.entries()].sort((x, y) => y[1] - x[1])) out.push(row(titleCase(t), formatMoney(v), pct(ratioPercent(v, c.currentValue))));
  } else out.push(statusLine(a, "investments"));

  out.push("\n## 8. SIP analysis");
  if (c.sips.length > 0) {
    out.push(`Active SIPs: ${c.sips.length}; monthly-equivalent contribution ${formatMoney(c.sipMonthly)}.`);
    out.push(row("SIP", "Amount", "Frequency", "Day", "Since", "Paid in last 12 months"), row("---", "---:", "---", "---", "---", "---:"));
    for (const i of c.sips) out.push(row(i.name, formatMoney(i.monthlyContribution ?? 0), titleCase(i.contributionFrequency), i.contributionDay ?? "—", i.contributionStartDate ? i.contributionStartDate.toISOString().slice(0, 10) : "—", `${formatMoney(i.contributions12m)} (${i.contributionCount12m} entries)`));
  } else out.push(statusLine(a, "sips"));

  out.push("\n## 9. Loan analysis");
  if (c.loans.length > 0) {
    out.push(`Outstanding ${formatMoney(c.totalOutstanding)}; total EMI ${formatMoney(c.totalEmi)} per month${s.monthlyIncome ? ` (${pct(ratioPercent(c.totalEmi, s.monthlyIncome))} of this month's income)` : ""}.`);
    out.push(row("Lender", "Type", "Outstanding", "EMI", "Rate", "Tenure left (est.)"), row("---", "---", "---:", "---:", "---:", "---:"));
    for (const l of c.loans) out.push(row(l.lender, titleCase(l.type), formatMoney(l.outstanding), formatMoney(l.emi), `${l.ratePercent}%`, `${remainingMonths(l)} months`));
  } else out.push(statusLine(a, "loans"));

  out.push("\n## 10. Insurance analysis");
  if (c.policies.length > 0 && c.insurance) {
    out.push(row("Insurer", "Type", "Cover", "Premium", "Frequency", "Yearly cost", "Renewal", "Recorded payments"), row("---", "---", "---:", "---:", "---", "---:", "---", "---:"));
    for (const p of c.policies) out.push(row(p.provider, titleCase(p.type), formatMoney(p.coverage), formatMoney(p.premiumAmount), titleCase(p.frequency), formatMoney(annualise(p.premiumAmount, p.frequency) ?? 0), p.renewalDate.toISOString().slice(0, 10), `${formatMoney(p.recordedPaid)} (${p.recordedCount})`));
    out.push(`Calculated in code: premium amounts listed add up to ${formatMoney(c.insurance.listedPremiumSum)} (one cycle each, mixed frequencies); yearly cost ${formatMoney(c.insurance.annualisedPremiumTotal)}; recorded payments ${formatMoney(c.insurance.recordedPaidTotal)}.`);
    out.push(c.insurance.note);
  } else out.push(statusLine(a, "insurance"));

  out.push("\n## 11. Goal progress");
  if (c.goals.length > 0) {
    const now = new Date(a.asOf);
    out.push(row("Goal", "Target", "Saved", "Progress", "Deadline", "Needed per month", "Set per month"), row("---", "---:", "---:", "---:", "---", "---:", "---:"));
    for (const g of c.goals) out.push(row(g.name, formatMoney(g.target), formatMoney(g.current), pct(ratioPercent(g.current, g.target)), g.deadline.toISOString().slice(0, 10), formatMoney(requiredMonthly(g, now)), formatMoney(g.monthlyContribution)));
  } else out.push(statusLine(a, "goals"));

  out.push("\n## 12. Recurring payments");
  if (s.spending && s.spending.recurring.length > 0) {
    out.push(`Estimated monthly total: ${formatMoney(s.spending.recurringMonthlyTotal)}.`);
    out.push(row("Merchant", "Category", "Typical charge", "Seen", "Found by"), row("---", "---", "---:", "---:", "---"));
    for (const r of s.spending.recurring.slice(0, 10)) out.push(row(r.merchant, r.category, formatMoney(r.typicalAmount), r.occurrences, r.basis === "flagged_recurring" ? "your recurring flag" : "repeat pattern"));
  } else out.push(statusLine(a, "recurring"));

  out.push("\n## 13. Financial risks");
  out.push(a.risks.length > 0 ? a.risks.map((r) => `- ${r}`).join("\n") : "No rule-based risks were triggered by the data that was retrieved.");
  out.push("\n## 14. Opportunities");
  out.push(a.opportunities.length > 0 ? a.opportunities.map((r) => `- ${r}`).join("\n") : "No quantified opportunities were found in the data retrieved.");

  out.push("\n## 15. Data-quality issues");
  const dq = [...a.dataQuality, ...a.warnings, ...failed.map((d) => `${d.title} could not be retrieved (${d.error ?? "unknown error"}).`)];
  out.push(dq.length > 0 ? dq.map((r) => `- ${r}`).join("\n") : "No data-quality issues were reported.");
  if (c.discrepancies.length > 0) {
    out.push("\nRecord versus document differences (your records were not changed):");
    out.push(row("Document", "Item", "Field", "Your record", "Document says", "Status", "Detected"), row("---", "---", "---", "---", "---", "---", "---"));
    for (const d of c.discrepancies.slice(0, 10)) out.push(row(d.documentName, titleCase(d.entityType), d.field, d.databaseValue, d.documentValue, titleCase(d.status), d.createdAt.toISOString().slice(0, 10)));
  }

  out.push("\n## 16. Evidence and sources");
  out.push("All figures were computed in code from your own records as of " + a.asOf.slice(0, 10) + ": cash-flow ledger, holdings, loans, insurance policies, goals, expenses and income entries, and the data-health checks. Nothing in this report was estimated by a language model.");
  return out.join("\n");
}

function statusLine(a: FinancialAudit, key: DomainKey): string {
  const d = a.domains.find((x) => x.domain === key)!;
  return d.status === "failed" ? `${d.title}: retrieval failed — the data is unknown, not empty.` : `${d.title}: ${DOMAIN_STATUS_LABEL[d.status].toLowerCase()}. ${d.detail}`;
}

function remainingMonths(l: LoanRow): number {
  // monthsUntil(a, b) = a − b in months, so this is "now minus start".
  const elapsed = Math.max(0, monthsUntil(new Date(), l.startDate));
  return Math.max(0, l.tenureMonths - elapsed);
}
