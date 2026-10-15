import { GoalDTO } from "@wealthos/types";
import {
  Dec,
  ZERO,
  emergencyCoverageMonths,
  emergencyRemaining,
  emergencyTargetFromMonths,
  periodsUntil,
  projectGrowth,
  toDecimal,
} from "../../../common/financial-facts/financial-formulas";
import { calculateEmi } from "../../../simulator/simulator.engine";
import { Prisma } from "@wealthos/db";

// Deterministic Coach calculations. Pure functions: Decimal arithmetic, no I/O, no model.
//
// Reuse, not duplication: rates, projections, coverage and period arithmetic come from
// financial-formulas.ts (the authoritative formulas) and the EMI formula from the Simulator engine, the same
// ones Dashboard, Reports, Goals and Scenario Studio use. This file only adds what the Coach needs on top:
// period-completeness handling, presence-aware ("missing" vs "zero") inputs, expense classification that
// matches FinancialFactsService, and goal-state classification.
//
// Rates are RATIOS (0.25 = 25%) until presentation. Money leaves this file as numbers rounded to 2 dp.

const D = (v: Prisma.Decimal.Value): Dec => new Prisma.Decimal(v);
export const round2 = (d: Dec): number => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
export const roundPct1 = (ratio: Dec): number => ratio.times(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toNumber();

/** Rule-of-thumb emergency-fund target used only when the user has not set their own (a stated assumption, not a fact). */
export const DEFAULT_EMERGENCY_TARGET_MONTHS = 6;
/** Share of income going to EMIs above which the Coach calls the load elevated (a common lender benchmark, disclosed as such). */
export const EMI_TO_INCOME_CAUTION_RATIO = 0.4;
/** Interest rate above which a loan is treated as expensive debt worth prioritising (a disclosed heuristic). */
export const HIGH_INTEREST_RATE_PERCENT = 12;
/** A category counts as a significant increase at +30% AND at least this many rupees between comparable complete months. */
export const SIGNIFICANT_CATEGORY_INCREASE_RATIO = 0.3;
export const SIGNIFICANT_CATEGORY_INCREASE_MIN_RUPEES = 1000;
/** Illustrative inputs for a house question that does not state them. Always shown to the user as assumptions. */
export const ILLUSTRATIVE_HOUSE_ASSUMPTIONS = { downPaymentPercent: 20, annualRatePercent: 8.5, tenureYears: 20 } as const;

// --- Periods -----------------------------------------------------------------------------------

export interface MonthStatus {
  month: string;
  /** True only for a month that has fully ended. */
  complete: boolean;
  isFuture: boolean;
  daysElapsed: number;
  daysInMonth: number;
}

export function monthStatus(month: string, now: Date): MonthStatus {
  const [y, m] = month.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const nextStart = Date.UTC(y, m, 1);
  const daysInMonth = Math.round((nextStart - start) / 86_400_000);
  const nowMs = now.getTime();
  if (nowMs < start) return { month, complete: false, isFuture: true, daysElapsed: 0, daysInMonth };
  if (nowMs >= nextStart) return { month, complete: true, isFuture: false, daysElapsed: daysInMonth, daysInMonth };
  const daysElapsed = Math.min(daysInMonth, now.getUTCDate());
  return { month, complete: false, isFuture: false, daysElapsed, daysInMonth };
}

// --- Presence-aware amounts ----------------------------------------------------------------------

/** A sum together with how many records produced it, so "no records" is never mistaken for "zero". */
export interface RecordedAmount {
  amount: Dec;
  count: number;
}

export function recorded(values: Array<Prisma.Decimal.Value>): RecordedAmount {
  return { amount: values.reduce<Dec>((acc, v) => acc.plus(D(v)), ZERO), count: values.length };
}

// --- Savings rate --------------------------------------------------------------------------------

export type SavingsRateReason = "NO_INCOME_RECORDED" | "NO_EXPENSES_RECORDED" | "FUTURE_PERIOD";

export interface SavingsRateResult {
  /** (income - spending) / income as a ratio; null when it cannot be computed honestly. */
  rate: Dec | null;
  reason: SavingsRateReason | null;
  complete: boolean;
  /** Set when the month is still running: the figure compares income received so far with spending so far. */
  estimate: boolean;
  income: Dec | null;
  spending: Dec | null;
  netSaved: Dec | null;
}

/**
 * Savings rate = (income - spending) / income, where "income" is income RECEIVED in the month and "spending"
 * is genuine spending (flowType EXPENSE, excluding SAVINGS-type categories, investments, emergency-fund
 * allocations and transfers — the FinancialFactsService definition). The definition is returned with the
 * answer so the user can see exactly what was divided by what.
 *
 * A month with no expense records is NOT treated as zero spending, and a month with no income records has no
 * rate at all. A month that has not finished is flagged as an estimate: income received so far is compared
 * with spending so far, so the result is not comparable with a complete month.
 */
export function computeSavingsRate(income: RecordedAmount, spending: RecordedAmount, status: MonthStatus): SavingsRateResult {
  const base = { complete: status.complete, estimate: !status.complete, income: null, spending: null, netSaved: null };
  if (status.isFuture) return { rate: null, reason: "FUTURE_PERIOD", ...base };
  if (income.count === 0 || income.amount.lte(0)) return { rate: null, reason: "NO_INCOME_RECORDED", ...base };
  if (spending.count === 0) return { rate: null, reason: "NO_EXPENSES_RECORDED", ...base, income: income.amount };
  const netSaved = income.amount.minus(spending.amount);
  return {
    rate: netSaved.div(income.amount),
    reason: null,
    complete: status.complete,
    estimate: !status.complete,
    income: income.amount,
    spending: spending.amount,
    netSaved,
  };
}

// --- Expense classification and categories ---------------------------------------------------------

export interface ExpenseRowLike {
  amount: Prisma.Decimal.Value;
  currency?: string | null;
  categoryName: string;
  categoryType: string;
  flowType?: string | null;
}

export interface CategoryTotal {
  name: string;
  total: Dec;
  count: number;
  /** Share of total genuine spending, as a ratio. */
  share: Dec;
}

export interface CategoryBreakdown {
  total: Dec;
  count: number;
  categories: CategoryTotal[];
  excluded: {
    /** Legacy SAVINGS-category rows: real cash out, but not spending. */
    savingsCount: number;
    savingsTotal: Dec;
    /** Rows in a currency other than INR. They are never silently added to rupee totals. */
    foreignCurrency: { currency: string; count: number }[];
    /** Non-EXPENSE flow types (other outflows). */
    otherFlowCount: number;
  };
}

/** Genuine spending by category, matching how FinancialFactsService defines "expenses". */
export function buildCategoryBreakdown(rows: ExpenseRowLike[]): CategoryBreakdown {
  const byName = new Map<string, { total: Dec; count: number }>();
  let total = ZERO;
  let count = 0;
  let savingsCount = 0;
  let savingsTotal = ZERO;
  let otherFlowCount = 0;
  const foreign = new Map<string, number>();

  for (const r of rows) {
    const currency = (r.currency ?? "INR").toUpperCase();
    if (currency !== "INR") {
      foreign.set(currency, (foreign.get(currency) ?? 0) + 1);
      continue;
    }
    if (r.flowType && r.flowType !== "EXPENSE") {
      otherFlowCount += 1;
      continue;
    }
    if (r.categoryType === "SAVINGS") {
      savingsCount += 1;
      savingsTotal = savingsTotal.plus(D(r.amount));
      continue;
    }
    const amount = D(r.amount);
    total = total.plus(amount);
    count += 1;
    const entry = byName.get(r.categoryName) ?? { total: ZERO, count: 0 };
    entry.total = entry.total.plus(amount);
    entry.count += 1;
    byName.set(r.categoryName, entry);
  }

  const categories = [...byName.entries()]
    .map(([name, v]) => ({ name, total: v.total, count: v.count, share: total.isZero() ? ZERO : v.total.div(total) }))
    .sort((a, b) => b.total.comparedTo(a.total) || a.name.localeCompare(b.name));

  return {
    total,
    count,
    categories,
    excluded: {
      savingsCount,
      savingsTotal,
      foreignCurrency: [...foreign.entries()].map(([currency, n]) => ({ currency, count: n })),
      otherFlowCount,
    },
  };
}

// Words a user is likely to use mapped to words a category name is likely to contain. Matching is on the
// user's own categories only: a hint with no matching category is reported as "no such category", not zero.
const CATEGORY_ALIASES: Record<string, string[]> = {
  food: ["food", "grocer", "dining", "restaurant", "meal", "eating", "snack", "swiggy", "zomato", "cafe", "coffee"],
  groceries: ["grocer", "food", "supermarket", "vegetable"],
  transport: ["transport", "fuel", "petrol", "diesel", "cab", "taxi", "uber", "ola", "metro", "commute", "travel"],
  travel: ["travel", "trip", "holiday", "vacation", "flight", "hotel"],
  rent: ["rent", "housing", "house", "home"],
  housing: ["housing", "rent", "house", "home", "maintenance"],
  shopping: ["shopping", "clothes", "apparel", "amazon", "retail"],
  entertainment: ["entertainment", "movie", "ott", "netflix", "games", "fun", "leisure"],
  health: ["health", "medical", "medicine", "pharmacy", "doctor", "hospital", "fitness", "gym"],
  medical: ["medical", "health", "medicine", "pharmacy", "doctor", "hospital"],
  education: ["education", "school", "tuition", "course", "college", "books"],
  utilities: ["utilit", "electric", "water", "gas", "internet", "broadband", "phone", "mobile", "bill"],
  bills: ["bill", "utilit", "electric", "internet", "phone", "recharge"],
  subscriptions: ["subscription", "netflix", "spotify", "prime", "ott"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** The user's own category names that match a free-text hint. Empty means "no such category exists". */
export function matchCategories(hint: string, categoryNames: string[]): string[] {
  const h = norm(hint);
  if (!h) return [];
  const singular = h.replace(/s$/, "");
  const needles = new Set<string>([h, singular, ...(CATEGORY_ALIASES[h] ?? []), ...(CATEGORY_ALIASES[singular] ?? [])]);
  return categoryNames.filter((name) => {
    const n = norm(name);
    const tokens = n.split(" ").filter(Boolean);
    // Whole-word / word-prefix matching, so "rent" does not match "Current account" and "food" matches "Food & Dining".
    return [...needles].some(
      (needle) =>
        needle.length >= 2 &&
        (n === needle || ` ${n} `.includes(` ${needle} `) || tokens.some((t) => t.startsWith(needle) || (t.length >= 4 && needle.startsWith(t)))),
    );
  });
}

export interface CategoryChange {
  name: string;
  previous: Dec;
  current: Dec;
  change: Dec;
  /** Ratio change (0.5 = +50%); null when the previous amount was zero. */
  changeRatio: Dec | null;
  significant: boolean;
}

/** Category changes between two COMPARABLE periods. The caller must pass complete months only. */
export function compareCategories(current: CategoryBreakdown, previous: CategoryBreakdown): CategoryChange[] {
  const names = new Set([...current.categories.map((c) => c.name), ...previous.categories.map((c) => c.name)]);
  const cur = new Map(current.categories.map((c) => [c.name, c.total]));
  const prev = new Map(previous.categories.map((c) => [c.name, c.total]));
  return [...names]
    .map((name) => {
      const c = cur.get(name) ?? ZERO;
      const p = prev.get(name) ?? ZERO;
      const change = c.minus(p);
      const changeRatio = p.isZero() ? null : change.div(p);
      const significant = change.gte(SIGNIFICANT_CATEGORY_INCREASE_MIN_RUPEES) && (changeRatio === null || changeRatio.gte(SIGNIFICANT_CATEGORY_INCREASE_RATIO));
      return { name, previous: p, current: c, change, changeRatio, significant };
    })
    .sort((a, b) => b.change.comparedTo(a.change));
}

// --- Emergency fund --------------------------------------------------------------------------------

export type EmergencyVerdict = "adequate" | "partial" | "low" | "unknown";

export interface EmergencyAssessment {
  balance: Dec;
  avgMonthlyEssential: Dec | null;
  coverageMonths: Dec | null;
  targetMonths: Dec | null;
  targetAmount: Dec | null;
  shortfall: Dec | null;
  verdict: EmergencyVerdict;
  /** True when the target is the Coach's default assumption rather than one the user set. */
  targetIsDefault: boolean;
  monthsOfData: number;
}

/**
 * Coverage = emergency cash / average monthly ESSENTIAL (NEED) expenses over the last complete months, the
 * shared FinancialFacts definition. Target = the user's own target when set, else a stated 6-month default.
 */
export function assessEmergencyFund(input: {
  balance: Prisma.Decimal.Value;
  avgMonthlyEssential: Prisma.Decimal.Value | null;
  monthsOfData: number;
  userTargetAmount?: Prisma.Decimal.Value | null;
  userTargetMonths?: Prisma.Decimal.Value | null;
}): EmergencyAssessment {
  const balance = D(input.balance);
  const avg = input.avgMonthlyEssential === null ? null : D(input.avgMonthlyEssential);
  const hasBaseline = avg !== null && avg.gt(0);
  const coverageMonths = hasBaseline ? emergencyCoverageMonths(balance, avg!) : null;

  let targetMonths: Dec | null = null;
  let targetAmount: Dec | null = null;
  let targetIsDefault = false;
  if (input.userTargetAmount !== undefined && input.userTargetAmount !== null) {
    targetAmount = D(input.userTargetAmount);
    targetMonths = hasBaseline ? targetAmount.div(avg!) : null;
  } else {
    const months = input.userTargetMonths !== undefined && input.userTargetMonths !== null ? D(input.userTargetMonths) : D(DEFAULT_EMERGENCY_TARGET_MONTHS);
    targetIsDefault = input.userTargetMonths === undefined || input.userTargetMonths === null;
    targetMonths = months;
    targetAmount = hasBaseline ? emergencyTargetFromMonths(months, avg!) : null;
  }

  const shortfall = targetAmount ? emergencyRemaining(targetAmount, balance) : null;
  let verdict: EmergencyVerdict = "unknown";
  if (coverageMonths && targetMonths) {
    verdict = coverageMonths.gte(targetMonths) ? "adequate" : coverageMonths.gte(targetMonths.div(2)) ? "partial" : "low";
  }
  return { balance, avgMonthlyEssential: avg, coverageMonths, targetMonths, targetAmount, shortfall, verdict, targetIsDefault, monthsOfData: input.monthsOfData };
}

// --- Debt ------------------------------------------------------------------------------------------------

/** Total EMI / monthly income, or null when no income is recorded (never divides by zero or invents a ratio). */
export function emiToIncomeRatio(totalEmi: Prisma.Decimal.Value, monthlyIncome: Prisma.Decimal.Value | null): Dec | null {
  if (monthlyIncome === null) return null;
  const income = D(monthlyIncome);
  return income.lte(0) ? null : D(totalEmi).div(income);
}

// --- Goals -------------------------------------------------------------------------------------------------

export type GoalState = "FUNDED" | "OVERDUE" | "ACTIVE";

export interface GoalAssessment {
  id: string;
  name: string;
  state: GoalState;
  target: number;
  saved: number;
  shortfall: number;
  progressPercent: number;
  monthlyContribution: number;
  /** Monthly amount still needed. 0 for a funded goal; null for an overdue one (no time left to spread it over). */
  requiredMonthly: number | null;
  /** current contribution / required; null when no contribution is required or it cannot be defined. */
  paceRatio: number | null;
  monthsLeft: number | null;
  onTrack: boolean;
  /** The stored requiredMonthlyContribution disagrees with the goal's real state (funded goal still showing a requirement). */
  staleRequirement: boolean;
}

/**
 * Classifies a goal from its own figures. A FUNDED goal needs nothing more, whatever a stored
 * requiredMonthlyContribution says (it can be stale, e.g. after a linked investment was revalued); an OVERDUE
 * goal has no months left to spread a requirement over, so none is fabricated. Only an ACTIVE goal reuses the
 * Goals module's own required-contribution figure.
 */
export function assessGoal(goal: GoalDTO, now: Date): GoalAssessment {
  const target = D(goal.targetAmount);
  const saved = D(goal.currentAmount).plus(D(goal.linkedInvestmentValue));
  const shortfall = target.minus(saved).lt(0) ? ZERO : target.minus(saved);
  const monthly = D(goal.monthlyContribution);
  const targetDate = new Date(goal.targetDate);
  const base = {
    id: goal.id,
    name: goal.name,
    target: round2(target),
    saved: round2(saved),
    shortfall: round2(shortfall),
    progressPercent: goal.progressPercent,
    monthlyContribution: round2(monthly),
  };

  if (shortfall.isZero()) {
    return { ...base, state: "FUNDED", requiredMonthly: 0, paceRatio: null, monthsLeft: null, onTrack: true, staleRequirement: Number(goal.requiredMonthlyContribution) > 0 };
  }
  const monthsLeft = periodsUntil(targetDate, now, 30.4375);
  if (monthsLeft <= 0) {
    return { ...base, state: "OVERDUE", requiredMonthly: null, paceRatio: null, monthsLeft: 0, onTrack: false, staleRequirement: false };
  }
  const required = D(goal.requiredMonthlyContribution);
  const paceRatio = required.gt(0) ? monthly.div(required).toDecimalPlaces(3).toNumber() : null;
  const onTrack = required.lte(0) || (paceRatio !== null && paceRatio >= 0.95);
  return { ...base, state: "ACTIVE", requiredMonthly: round2(required), paceRatio, monthsLeft, onTrack, staleRequirement: false };
}

// --- Growth / SIP -------------------------------------------------------------------------------------------

export interface GrowthSummary {
  projectedValue: Dec;
  totalContributions: Dec;
  projectedGain: Dec;
}

/** Monthly SIP projection using the authoritative projectGrowth (contributions at the START of each month). */
export function projectSip(input: { currentValue: Prisma.Decimal.Value; monthlySip: Prisma.Decimal.Value; annualReturnPercent: number; years: number }): GrowthSummary {
  const p = projectGrowth({
    currentValue: D(input.currentValue),
    contributionPerPeriod: D(input.monthlySip),
    cadence: "MONTHLY",
    annualReturnPercent: D(input.annualReturnPercent),
    years: input.years,
  });
  return { projectedValue: p.projectedValue, totalContributions: p.totalContributions, projectedGain: p.projectedGain };
}

export interface SipComparison {
  baseline: GrowthSummary;
  proposed: GrowthSummary;
  extraProjectedValue: Dec;
  extraContributions: Dec;
  extraGain: Dec;
}

export function compareSipIncrease(input: { currentValue: Prisma.Decimal.Value; currentSip: Prisma.Decimal.Value; increase: Prisma.Decimal.Value; annualReturnPercent: number; years: number }): SipComparison {
  const baseline = projectSip({ currentValue: input.currentValue, monthlySip: input.currentSip, annualReturnPercent: input.annualReturnPercent, years: input.years });
  const proposed = projectSip({ currentValue: input.currentValue, monthlySip: D(input.currentSip).plus(D(input.increase)), annualReturnPercent: input.annualReturnPercent, years: input.years });
  return {
    baseline,
    proposed,
    extraProjectedValue: proposed.projectedValue.minus(baseline.projectedValue),
    extraContributions: proposed.totalContributions.minus(baseline.totalContributions),
    extraGain: proposed.projectedGain.minus(baseline.projectedGain),
  };
}

/**
 * The level monthly contribution that grows `currentValue` to `target` in `months` months at `annualReturnPercent`,
 * with contributions at the START of each month — the exact inverse of projectGrowth's convention. Zero when the
 * existing value alone reaches the target; null when there is no time left.
 */
export function requiredMonthlyContribution(input: { target: Prisma.Decimal.Value; currentValue: Prisma.Decimal.Value; annualReturnPercent: number; months: number }): Dec | null {
  const months = Math.floor(input.months);
  if (months <= 0) return null;
  const target = D(input.target);
  const current = D(input.currentValue);
  const r = D(input.annualReturnPercent).div(1200);
  if (r.isZero()) {
    const gap = target.minus(current);
    return gap.lte(0) ? ZERO : gap.div(months);
  }
  const growth = r.plus(1).pow(months);
  const gap = target.minus(current.times(growth));
  if (gap.lte(0)) return ZERO;
  const annuityDueFactor = growth.minus(1).div(r).times(r.plus(1));
  return gap.div(annuityDueFactor);
}

/** Whole months for `monthly` (start-of-month contributions) to grow `currentValue` to `target`; null when it never does within the cap. */
export function monthsToReach(input: { target: Prisma.Decimal.Value; currentValue: Prisma.Decimal.Value; monthly: Prisma.Decimal.Value; annualReturnPercent: number; maxMonths?: number }): number | null {
  const target = D(input.target);
  let balance = D(input.currentValue);
  if (balance.gte(target)) return 0;
  const monthly = D(input.monthly);
  const r = D(input.annualReturnPercent).div(1200);
  const cap = input.maxMonths ?? 600;
  for (let m = 1; m <= cap; m++) {
    balance = balance.plus(monthly).times(r.plus(1));
    if (balance.gte(target)) return m;
  }
  return null;
}

// --- Loans ----------------------------------------------------------------------------------------------------

export interface HouseAffordability {
  price: Dec;
  downPaymentPercent: number;
  downPayment: Dec;
  loanAmount: Dec;
  annualRatePercent: number;
  tenureYears: number;
  newEmi: Dec;
  totalEmiAfter: Dec;
  emiToIncomeAfter: Dec | null;
  cashAfterDownPayment: Dec | null;
  monthlySurplusAfter: Dec | null;
  emergencyTargetAmount: Dec | null;
  shortfallVsEmergencyTarget: Dec | null;
  verdict: "comfortable" | "stretch" | "not_affordable" | "unknown";
  reasons: string[];
}

/**
 * Affordability of a purchase financed by a loan, from the user's own figures. The EMI uses the Simulator
 * engine's calculateEmi. Excludes stamp duty, registration and other closing costs (stated by the caller).
 * Verdict rules, in order: no surplus or negative cash after the down payment -> not_affordable; EMI load above
 * the caution ratio, or cash left below the emergency target -> stretch; otherwise comfortable. Unknown when
 * income or cash is not recorded.
 */
export function assessHousePurchase(input: {
  price: number;
  downPaymentPercent: number;
  annualRatePercent: number;
  tenureYears: number;
  monthlyIncome: Prisma.Decimal.Value | null;
  monthlySpending: Prisma.Decimal.Value | null;
  existingMonthlyEmi: Prisma.Decimal.Value;
  availableCash: Prisma.Decimal.Value | null;
  emergencyTargetAmount: Prisma.Decimal.Value | null;
}): HouseAffordability {
  const price = D(input.price);
  const downPayment = price.times(input.downPaymentPercent).div(100);
  const loanAmount = price.minus(downPayment);
  const emi = D(calculateEmi(loanAmount.toNumber(), input.annualRatePercent, input.tenureYears * 12));
  const totalEmiAfter = D(input.existingMonthlyEmi).plus(emi);
  const income = input.monthlyIncome === null ? null : D(input.monthlyIncome);
  const emiToIncomeAfter = income && income.gt(0) ? totalEmiAfter.div(income) : null;
  const cashAfter = input.availableCash === null ? null : D(input.availableCash).minus(downPayment);
  const surplusAfter = income && input.monthlySpending !== null ? income.minus(D(input.monthlySpending)).minus(totalEmiAfter) : null;
  const target = input.emergencyTargetAmount === null ? null : D(input.emergencyTargetAmount);
  const shortfall = target && cashAfter ? emergencyRemaining(target, cashAfter.lt(0) ? ZERO : cashAfter) : null;

  const reasons: string[] = [];
  let verdict: HouseAffordability["verdict"] = "unknown";
  if (income && income.gt(0) && cashAfter !== null) {
    verdict = "comfortable";
    if (surplusAfter !== null && surplusAfter.lt(0)) {
      verdict = "not_affordable";
      reasons.push("monthly income would not cover spending plus all EMIs");
    }
    if (cashAfter.lt(0)) {
      verdict = "not_affordable";
      reasons.push("available cash is less than the down payment");
    }
    if (verdict === "comfortable") {
      if (emiToIncomeAfter && emiToIncomeAfter.gt(EMI_TO_INCOME_CAUTION_RATIO)) {
        verdict = "stretch";
        reasons.push(`EMIs would be above ${Math.round(EMI_TO_INCOME_CAUTION_RATIO * 100)}% of income`);
      }
      if (shortfall && shortfall.gt(0)) {
        verdict = "stretch";
        reasons.push("cash left after the down payment is below your emergency-fund target");
      }
    }
  }

  return {
    price,
    downPaymentPercent: input.downPaymentPercent,
    downPayment,
    loanAmount,
    annualRatePercent: input.annualRatePercent,
    tenureYears: input.tenureYears,
    newEmi: emi,
    totalEmiAfter,
    emiToIncomeAfter,
    cashAfterDownPayment: cashAfter,
    monthlySurplusAfter: surplusAfter,
    emergencyTargetAmount: target,
    shortfallVsEmergencyTarget: shortfall,
    verdict,
    reasons,
  };
}

export { toDecimal };
