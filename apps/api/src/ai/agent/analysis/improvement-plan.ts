import { AuditSnapshot, monthsUntil, requiredMonthly } from "./financial-audit";
import { round2 } from "./financial-math";
import { formatMoney } from "./financial-verification";

// Builds a prioritised, measurable improvement plan from the audit snapshot. Every target is either computed from the
// user's own recorded figures ("data") or comes from a stated rule of thumb ("benchmark"), and each recommendation says
// which. Nothing here asks the user for a target amount, and nothing here is saved: it is a recommendation set, not a
// tracked plan.

export const BENCHMARKS = {
  savingsRatePercent: 20,
  emergencyFundMonths: 6,
  maxDebtToIncomePercent: 40,
  highInterestRatePercent: 12,
  termCoverIncomeMultiple: 10,
  surplusShareToEmergencyFund: 0.5,
} as const;

export type TargetBasis = "data" | "benchmark";

export interface Recommendation {
  priority: number;
  key: string;
  problem: string;
  action: string;
  target: string;
  timeline: string;
  expectedImpact: string;
  basis: TargetBasis;
  score: number; // internal ranking weight
}

export interface ImprovementPlan {
  recommendations: Recommendation[];
  assumptions: string[];
  missingInputs: string[];
  markdown: string;
}

const INSUFFICIENT = "Needs income and spending data first";

export function buildImprovementPlan(s: AuditSnapshot, now: Date = new Date()): ImprovementPlan {
  const recs: Omit<Recommendation, "priority">[] = [];
  const assumptions: string[] = [`Benchmarks used where noted: save ${BENCHMARKS.savingsRatePercent}% of income, hold ${BENCHMARKS.emergencyFundMonths} months of essential expenses, keep EMIs under ${BENCHMARKS.maxDebtToIncomePercent}% of income, ${BENCHMARKS.termCoverIncomeMultiple}× yearly income in term cover. These are common rules of thumb, not requirements.`];
  const missing: string[] = [];

  const useReference = (s.monthlyIncome === null || s.monthlyIncome <= 0) && !!s.referenceIncome;
  const income = useReference ? s.referenceIncome!.amount : s.monthlyIncome;
  const refExpenses = useReference ? s.spending?.averageMonthly ?? null : null;
  const expenses = refExpenses ?? s.monthlyExpenses;
  if (useReference) assumptions.push(`Income is the ${s.referenceIncome!.basis}${refExpenses !== null ? "; spending is the average of complete months, so the two are comparable" : ""}.`);
  if (income === null || income <= 0) missing.push("This month's income (needed for savings-rate and debt-ratio targets).");
  if (expenses === null) missing.push("This month's expenses.");
  const surplus = income !== null && expenses !== null ? round2(income - expenses) : null;
  const emi = s.loans?.totalEmi ?? 0;
  const sip = s.activeSipMonthly ?? 0;

  // 1. Spending above income / low savings rate
  if (income && income > 0 && expenses !== null) {
    const targetSaving = round2((income * BENCHMARKS.savingsRatePercent) / 100);
    const currentSaving = round2(Math.max(0, income - expenses));
    if (expenses > income) {
      recs.push({
        key: "deficit",
        problem: `Spending (${formatMoney(expenses)}) is above income (${formatMoney(income)}) this month — a shortfall of ${formatMoney(expenses - income)}.`,
        action: "Cut or defer spending until it is at or below income; start with the discretionary categories and recurring payments listed below.",
        target: `Monthly spending at or below ${formatMoney(income)} (reduce by at least ${formatMoney(expenses - income)})`,
        timeline: "Within 1–2 months",
        expectedImpact: `Stops a ${formatMoney(expenses - income)}/month drain on cash.`,
        basis: "data",
        score: 100,
      });
    } else if (currentSaving < targetSaving) {
      const gap = round2(targetSaving - currentSaving);
      recs.push({
        key: "savings_rate",
        problem: `Savings rate is ${s.savingsRatePercent ?? Math.round(((income - expenses) / income) * 100)}% (${formatMoney(currentSaving)} left of ${formatMoney(income)}).`,
        action: `Raise monthly saving by ${formatMoney(gap)}, in steps of about ${formatMoney(round2(gap / 3))} a month over three months.`,
        target: `Save ${formatMoney(targetSaving)}/month (${BENCHMARKS.savingsRatePercent}% of income)`,
        timeline: "3 months",
        expectedImpact: `${formatMoney(gap * 12)} more saved over twelve months.`,
        basis: "benchmark",
        score: 70,
      });
    }
  }

  // 2. Emergency fund
  const ef = s.emergencyFund;
  const essential = ef?.avgMonthlyEssentialExpenses ?? s.spending?.essentialTotal ?? null;
  if (ef && essential && essential > 0) {
    const target = round2(essential * BENCHMARKS.emergencyFundMonths);
    if (ef.balance < target) {
      const shortfall = round2(target - ef.balance);
      const monthlyToEf = surplus !== null && surplus > 0 ? round2(surplus * BENCHMARKS.surplusShareToEmergencyFund) : 0;
      const months = monthlyToEf > 0 ? Math.ceil(shortfall / monthlyToEf) : null;
      recs.push({
        key: "emergency_fund",
        problem: `Emergency fund of ${formatMoney(ef.balance)} covers ${ef.coverageMonths ?? "fewer than " + BENCHMARKS.emergencyFundMonths} months of essential expenses; ${formatMoney(shortfall)} short of ${BENCHMARKS.emergencyFundMonths} months.`,
        action: monthlyToEf > 0 ? `Move ${formatMoney(monthlyToEf)}/month (half of this month's surplus) into the emergency fund.` : "Create a monthly surplus first, then direct part of it to the emergency fund.",
        target: `Emergency fund of ${formatMoney(target)} (${BENCHMARKS.emergencyFundMonths} × essential monthly spending of ${formatMoney(essential)})`,
        timeline: months !== null ? `About ${months} months at that pace` : "Starts once monthly spending is below income",
        expectedImpact: `Cover rises from ${ef.coverageMonths ?? "its current level"} to ${BENCHMARKS.emergencyFundMonths} months of essential expenses.`,
        basis: "benchmark",
        score: ef.coverageMonths !== null && ef.coverageMonths < 3 ? 90 : 60,
      });
    }
  } else if (!ef) missing.push("Emergency-fund figures.");

  // 3. High-interest debt
  for (const l of s.loans?.items ?? []) {
    if (l.ratePercent >= BENCHMARKS.highInterestRatePercent && l.outstanding > 0) {
      const monthlyInterest = round2((l.outstanding * l.ratePercent) / 100 / 12);
      recs.push({
        key: `debt_${l.lender}`,
        problem: `${l.lender} ${l.type.toLowerCase().replace(/_/g, " ")} loan costs ${l.ratePercent}% a year on ${formatMoney(l.outstanding)} outstanding.`,
        action: surplus !== null && surplus > 0 ? `Add part of your surplus as prepayment (for example ${formatMoney(round2(surplus * 0.5))}/month) after the emergency-fund step.` : "Prioritise this loan for prepayment once spending is below income.",
        target: `Clear ${formatMoney(l.outstanding)} outstanding`,
        timeline: surplus !== null && surplus > 0 ? `About ${Math.ceil(l.outstanding / Math.max(1, l.emi + surplus * 0.5))} months with the extra payment` : "Depends on freeing up cash flow",
        expectedImpact: `Removes about ${formatMoney(monthlyInterest)} a month of interest at today's balance.`,
        basis: "data",
        score: 80,
      });
    }
  }
  if (income && income > 0 && emi > 0) {
    const dti = round2((emi / income) * 100);
    if (dti >= BENCHMARKS.maxDebtToIncomePercent) {
      recs.push({
        key: "debt_to_income",
        problem: `EMIs of ${formatMoney(emi)} are ${dti}% of income.`,
        action: "Avoid new borrowing; prepay the highest-rate loan first or ask lenders about refinancing.",
        target: `EMIs below ${BENCHMARKS.maxDebtToIncomePercent}% of income (${formatMoney(round2((income * BENCHMARKS.maxDebtToIncomePercent) / 100))})`,
        timeline: "6–12 months",
        expectedImpact: `Frees up to ${formatMoney(round2(emi - (income * BENCHMARKS.maxDebtToIncomePercent) / 100))} a month.`,
        basis: "benchmark",
        score: 75,
      });
    }
  }

  // 4. Insurance
  if (s.insurance) {
    if (s.insurance.healthCover === 0) recs.push({ key: "health_cover", problem: "No health insurance policy is recorded.", action: "Add health cover (or record it if you already have one).", target: "A health policy recorded for you and dependants", timeline: "Within 1 month", expectedImpact: "Protects savings from a single medical bill.", basis: "benchmark", score: 85 });
    if (income && income > 0) {
      const needed = round2(income * 12 * BENCHMARKS.termCoverIncomeMultiple);
      if (s.insurance.termCover < needed) recs.push({ key: "term_cover", problem: `Term cover recorded is ${formatMoney(s.insurance.termCover)}; ${BENCHMARKS.termCoverIncomeMultiple}× yearly income is ${formatMoney(needed)}.`, action: "Review term cover if others depend on your income.", target: `Term cover of about ${formatMoney(needed)} where you have dependants`, timeline: "Within 3 months", expectedImpact: `Closes a ${formatMoney(needed - s.insurance.termCover)} protection gap.`, basis: "benchmark", score: 40 });
    }
    for (const p of s.insurance.reconciliation.policiesNeedingReview.slice(0, 2)) recs.push({ key: `ins_${p.policy}`, problem: `Insurance "${p.policy}": ${p.reason}`, action: "Check the policy record against the insurer's document and correct whichever is wrong.", target: "Records match the policy document", timeline: "Within 1 month", expectedImpact: "Reliable premium and renewal tracking.", basis: "data", score: 35 });
  }

  // 5. Goals
  for (const g of s.goals ?? []) {
    if (monthsUntil(g.deadline, now) > 0 && g.current < g.target) {
      const need = requiredMonthly(g, now);
      if (need > g.monthlyContribution + 1) recs.push({ key: `goal_${g.name}`, problem: `Goal "${g.name}" needs ${formatMoney(need)}/month but is set to ${formatMoney(g.monthlyContribution)}/month.`, action: `Raise the monthly contribution by ${formatMoney(round2(need - g.monthlyContribution))} or move the deadline.`, target: `${formatMoney(g.target)} by ${g.deadline.toISOString().slice(0, 10)}`, timeline: `${monthsUntil(g.deadline, now)} months`, expectedImpact: `Goal fully funded by its deadline (before any investment growth).`, basis: "data", score: 55 });
    }
  }

  // 6. Spending trims & subscriptions
  const sp = s.spending;
  if (sp && sp.opportunityMonthlyTotal > 0) recs.push({ key: "trim", problem: `Discretionary categories are above your own usual month by ${formatMoney(sp.opportunityMonthlyTotal)}.`, action: `Bring those categories back to their usual level: ${sp.opportunities.filter((o) => !o.label.startsWith("Review")).slice(0, 3).map((o) => o.label.replace("Bring ", "").replace(" back to your usual month", "")).join(", ")}.`, target: `Save ${formatMoney(sp.opportunityMonthlyTotal)}/month`, timeline: "Next month", expectedImpact: `${formatMoney(sp.opportunityMonthlyTotal * 12)} over twelve months if sustained.`, basis: "data", score: 50 });
  if (sp && sp.recurring.length > 0) recs.push({ key: "subscriptions", problem: `${sp.recurring.length} recurring payment(s) cost about ${formatMoney(sp.recurringMonthlyTotal)} a month.`, action: "Review each one and cancel what you no longer use.", target: "Every recurring payment is one you use", timeline: "This month", expectedImpact: `Up to ${formatMoney(sp.recurringMonthlyTotal)}/month, only for what you cancel.`, basis: "data", score: 30 });

  // 7. Investing the surplus
  if (surplus !== null && surplus > 0 && sip === 0 && s.investmentValue !== null) recs.push({ key: "start_sip", problem: `You have ${formatMoney(surplus)} left this month and no active SIP.`, action: "After the emergency fund is on track, start a SIP with a share of the surplus.", target: `A SIP of up to ${formatMoney(round2(surplus * 0.25))}/month (a quarter of the current surplus)`, timeline: "After the emergency-fund step", expectedImpact: `${formatMoney(round2(surplus * 0.25 * 12))} invested per year; returns are not guaranteed.`, basis: "benchmark", score: 25 });

  const ranked = recs.sort((a, b) => b.score - a.score).map((r, i) => ({ ...r, priority: i + 1 }));
  const plan: ImprovementPlan = { recommendations: ranked, assumptions, missingInputs: missing, markdown: "" };
  plan.markdown = renderPlan(plan, s);
  return plan;
}

function renderPlan(p: ImprovementPlan, s: AuditSnapshot): string {
  const out: string[] = ["## Prioritised financial improvement plan"];
  out.push("These are recommendations built from your recorded figures. Nothing has been saved or changed.");
  if (p.recommendations.length === 0) out.push(p.missingInputs.length > 0 ? `${INSUFFICIENT}: ${p.missingInputs.join(" ")}` : "Your recorded figures did not trigger any of the checks, so there is no priority action to list.");
  else {
    out.push("| Priority | Problem | Recommended action | Measurable target | Timeline | Expected impact | Basis |", "|---:|---|---|---|---|---|---|");
    for (const r of p.recommendations) out.push(`| ${r.priority} | ${r.problem} | ${r.action} | ${r.target} | ${r.timeline} | ${r.expectedImpact} | ${r.basis === "data" ? "Your data" : "Benchmark"} |`);
  }
  if (s.monthlyIncome !== null && s.monthlyExpenses !== null) {
    const rate = s.savingsRatePercent !== null ? `${s.savingsRatePercent}%` : "not computable (no income recorded this month)";
    out.push(`\nStarting point (this month): income ${formatMoney(s.monthlyIncome)}, spending ${formatMoney(s.monthlyExpenses)}, savings rate ${rate}.`);
  }
  if (p.missingInputs.length > 0) out.push(`\nNot assessed (missing data): ${p.missingInputs.join(" ")}`);
  out.push("\nAssumptions:\n" + p.assumptions.map((a) => `- ${a}`).join("\n"));
  out.push("\nTo track any of these as a saved plan, ask me to create it — I will confirm the target with you and ask for your approval before saving anything.");
  return out.join("\n");
}
