import { Prisma } from "@wealthos/db";

// Authoritative financial formulas — pure functions, Decimal arithmetic only.
//
// Every consumer (Dashboard, Reports, Goals, AI Coach, Scenario Studio) must obtain
// these numbers via FinancialFactsService, which calls the functions below. No other
// file should re-implement savings rate, investment rate, available cash, total cash,
// emergency coverage or net worth.
//
// Rates are returned as RATIOS (0.25 = 25%). Multiply by 100 only at presentation time
// (see formatRatioAsPercent) — never store or pass a pre-multiplied percentage around.

export type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value): Dec => new Prisma.Decimal(v);
export const ZERO = D(0);

export const toDecimal = (v: Prisma.Decimal.Value | null | undefined): Dec =>
  v === null || v === undefined ? ZERO : D(v);

export const sumDecimals = (values: Array<Prisma.Decimal.Value | null | undefined>): Dec =>
  values.reduce<Dec>((acc, v) => acc.plus(toDecimal(v)), ZERO);

// Presentation helpers — the only place rounding happens.
export const toMoneyString = (v: Dec): string => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
export const formatRatioAsPercent = (ratio: Dec, dp = 2): string =>
  `${ratio.times(100).toDecimalPlaces(dp, Prisma.Decimal.ROUND_HALF_UP).toFixed(dp)}%`;

/** (income - expenses) / income. Null when income is zero (undefined, never fabricated). */
export function savingsRate(income: Dec, expenses: Dec): Dec | null {
  return income.isZero() ? null : income.minus(expenses).div(income);
}

/** investment contributions / income. */
export function investmentRate(contributions: Dec, income: Dec): Dec | null {
  return income.isZero() ? null : contributions.div(income);
}

/** expenses / income. */
export function expenseRate(expenses: Dec, income: Dec): Dec | null {
  return income.isZero() ? null : expenses.div(income);
}

// --- Investment cashflow classification --------------------------------------------

export type CashflowType =
  | "CONTRIBUTION"
  | "WITHDRAWAL"
  | "SALE"
  | "DIVIDEND"
  | "FEE"
  | "EMPLOYER_CONTRIBUTION"
  | "INTEREST"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

export interface CashflowTotals {
  contributions: Dec;
  employerContributions: Dec;
  withdrawals: Dec;
  saleProceeds: Dec;
  dividends: Dec;
  fees: Dec;
  interest: Dec;
  transfersIn: Dec;
  transfersOut: Dec;
}

export const emptyCashflowTotals = (): CashflowTotals => ({
  contributions: ZERO,
  employerContributions: ZERO,
  withdrawals: ZERO,
  saleProceeds: ZERO,
  dividends: ZERO,
  fees: ZERO,
  interest: ZERO,
  transfersIn: ZERO,
  transfersOut: ZERO,
});

const TOTAL_KEY: Record<CashflowType, keyof CashflowTotals> = {
  CONTRIBUTION: "contributions",
  WITHDRAWAL: "withdrawals",
  SALE: "saleProceeds",
  DIVIDEND: "dividends",
  FEE: "fees",
  EMPLOYER_CONTRIBUTION: "employerContributions",
  INTEREST: "interest",
  TRANSFER_IN: "transfersIn",
  TRANSFER_OUT: "transfersOut",
};

export function addCashflow(totals: CashflowTotals, type: CashflowType, amount: Prisma.Decimal.Value): CashflowTotals {
  const key = TOTAL_KEY[type];
  return { ...totals, [key]: totals[key].plus(toDecimal(amount)) };
}

/**
 * Cash-model effect of each cashflow type on the USER'S available cash.
 *
 *   CONTRIBUTION  -> outflow     (money left cash for the investment)
 *   WITHDRAWAL    -> inflow
 *   SALE          -> inflow
 *   everything else is NOT a user-cash movement:
 *     EMPLOYER_CONTRIBUTION  never touched the user's bank
 *     INTEREST               credited inside the balance
 *     TRANSFER_IN/OUT        internal movement between holdings
 *     DIVIDEND / FEE         if paid in/out of the user's own cash, record them as
 *                            Income / Expense so they are not counted twice.
 */
export function investmentCashOutflow(t: CashflowTotals): Dec {
  return t.contributions;
}
export function investmentCashInflow(t: CashflowTotals): Dec {
  return t.withdrawals.plus(t.saleProceeds);
}

export interface InvestmentMetricsInput {
  totals: CashflowTotals;
  /** Latest valid InvestmentValuation (or the legacy Investment.currentValue fallback). */
  currentValue: Dec;
  /** Sum of RealizedGainEvent.costBasisPortion for this investment. */
  realizedCostBasisSold: Dec;
  /** Sum of RealizedGainEvent.gainAmount for this investment. */
  realizedGain: Dec;
}

export interface InvestmentMetrics {
  grossContributions: Dec;
  employerContributions: Dec;
  withdrawals: Dec;
  netContributions: Dec; // contributions - withdrawals (per spec)
  costBasis: Dec;
  currentValue: Dec;
  unrealizedGain: Dec;
  realizedGain: Dec;
  dividends: Dec;
  fees: Dec;
  totalReturn: Dec;
  returnPercentage: Dec | null; // ratio
}

/**
 * Keeps the concepts separate, per spec:
 *
 *   invested  = contributions + employer contributions + transfers in   (external money in)
 *   returned  = withdrawals + sale proceeds + transfers out             (external money out)
 *   costBasis = invested - cost basis already realized by sales
 *   unrealized= currentValue - costBasis
 *   totalReturn = currentValue + returned + dividends - fees - invested
 *
 * It is deliberately NOT "currentValue - all historical deposits": withdrawals and
 * sales are added back, so a partly-withdrawn holding does not look like a loss.
 * INTEREST is already inside currentValue and is therefore reported, not re-added.
 */
export function deriveInvestmentMetrics(i: InvestmentMetricsInput): InvestmentMetrics {
  const t = i.totals;
  const invested = t.contributions.plus(t.employerContributions).plus(t.transfersIn);
  const returned = t.withdrawals.plus(t.saleProceeds).plus(t.transfersOut);
  const costBasis = invested.minus(i.realizedCostBasisSold);
  const totalReturn = i.currentValue.plus(returned).plus(t.dividends).minus(t.fees).minus(invested);
  return {
    grossContributions: t.contributions,
    employerContributions: t.employerContributions,
    withdrawals: t.withdrawals,
    netContributions: t.contributions.minus(t.withdrawals),
    costBasis,
    currentValue: i.currentValue,
    unrealizedGain: i.currentValue.minus(costBasis),
    realizedGain: i.realizedGain,
    dividends: t.dividends,
    fees: t.fees,
    totalReturn,
    returnPercentage: invested.isZero() ? null : totalReturn.div(invested),
  };
}

// --- Emergency reserve --------------------------------------------------------------

export type EmergencyEntryType = "ALLOCATE" | "RELEASE" | "WITHDRAWAL" | "ADJUSTMENT" | "TRANSFER_IN" | "TRANSFER_OUT";

export interface EmergencyEntryLike {
  type: EmergencyEntryType;
  amount: Prisma.Decimal.Value;
}

/** Effect on the reserve balance (Emergency Cash). */
export function emergencyReserveDelta(e: EmergencyEntryLike): Dec {
  const a = D(e.amount);
  switch (e.type) {
    case "ALLOCATE":
    case "TRANSFER_IN":
      return a.abs();
    case "RELEASE":
    case "WITHDRAWAL":
    case "TRANSFER_OUT":
      return a.abs().negated();
    case "ADJUSTMENT":
      return a; // signed
  }
}

/**
 * Effect on AVAILABLE cash. Allocation moves cash into the reserve (available falls,
 * total is unchanged); RELEASE/WITHDRAWAL moves it back (the spend that follows is a
 * separate Expense). ADJUSTMENT / TRANSFER_* cross the boundary of the cash model, so
 * they change Emergency Cash (and therefore Total Cash) without touching Available Cash.
 */
export function emergencyAvailableCashDelta(e: EmergencyEntryLike): Dec {
  const a = D(e.amount).abs();
  switch (e.type) {
    case "ALLOCATE":
      return a.negated();
    case "RELEASE":
    case "WITHDRAWAL":
      return a;
    default:
      return ZERO;
  }
}

export function emergencyCash(entries: EmergencyEntryLike[]): Dec {
  return entries.reduce<Dec>((acc, e) => acc.plus(emergencyReserveDelta(e)), ZERO);
}

/**
 * Emergency Coverage Months = Emergency Cash / Average MONTHLY Essential Expenses.
 * The input is already a monthly figure — it must NOT be divided by 12 again (the
 * legacy bug this replaces). Null when there is no essential-expense baseline.
 */
export function emergencyCoverageMonths(emergencyCashAmount: Dec, avgMonthlyEssentialExpenses: Dec): Dec | null {
  return avgMonthlyEssentialExpenses.lte(0) ? null : emergencyCashAmount.div(avgMonthlyEssentialExpenses);
}

// --- Cash model & net worth ---------------------------------------------------------

export interface CashModelInput {
  income: Dec;
  expenses: Dec;
  investmentCashOutflow: Dec;
  investmentCashInflow: Dec;
  emergencyAvailableCashDelta: Dec;
  emergencyCashAmount: Dec;
  /** Legacy SAVINGS-category expense rows not yet migrated: real cash left the account,
   *  but they are neither spending nor yet a proper contribution/allocation. */
  unclassifiedOutflow: Dec;
  otherCashOutflow?: Dec;
  otherCashInflow?: Dec;
}

export interface CashModel {
  availableCash: Dec;
  emergencyCash: Dec;
  totalCash: Dec;
}

/**
 * Available Cash = income - expenses - investment cash outflows - emergency allocations
 *                  - other actual outflows + applicable inflows.
 * Total Cash     = Available Cash + Emergency Cash.
 */
export function computeCashModel(i: CashModelInput): CashModel {
  const availableCash = i.income
    .minus(i.expenses)
    .minus(i.investmentCashOutflow)
    .plus(i.investmentCashInflow)
    .plus(i.emergencyAvailableCashDelta)
    .minus(i.unclassifiedOutflow)
    .minus(i.otherCashOutflow ?? ZERO)
    .plus(i.otherCashInflow ?? ZERO);
  return { availableCash, emergencyCash: i.emergencyCashAmount, totalCash: availableCash.plus(i.emergencyCashAmount) };
}

export interface NetWorthInput {
  availableCash: Dec;
  emergencyCash: Dec;
  investments: Dec;
  property: Dec;
  business: Dec;
  otherAssets: Dec;
  loans: Dec;
  creditCardOutstanding: Dec;
  otherLiabilities: Dec;
}

export interface NetWorth {
  totalAssets: Dec;
  totalLiabilities: Dec;
  netWorth: Dec;
}

/** Net Worth = Total Assets - Total Liabilities. Contributions and emergency allocations
 *  only move value between asset buckets, so neither reduces it. */
export function computeNetWorth(i: NetWorthInput): NetWorth {
  const totalAssets = i.availableCash.plus(i.emergencyCash).plus(i.investments).plus(i.property).plus(i.business).plus(i.otherAssets);
  const totalLiabilities = i.loans.plus(i.creditCardOutstanding).plus(i.otherLiabilities);
  return { totalAssets, totalLiabilities, netWorth: totalAssets.minus(totalLiabilities) };
}

// --- Receivables (money given that is expected back) ------------------------------------
//
// Giving ₹5,000 to a friend is NOT spending: cash falls by ₹5,000 and a receivable ASSET of
// ₹5,000 appears, so net worth is unchanged and no expense is recorded. Each repayment
// moves value back from the receivable into cash. Outstanding is always derived from the
// repayment ledger, never stored.

export type ReceivableStatusName = "OUTSTANDING" | "PARTIALLY_RETURNED" | "FULLY_RETURNED" | "OVERDUE" | "CANCELLED";

/** Receivable Outstanding = Total Given - Total Returned. Deliberately not clamped: a negative
 *  result means the data is wrong and must be visible, not hidden. */
export function receivableOutstanding(given: Dec, returned: Dec): Dec {
  return given.minus(returned);
}

/** The PERSISTED status implied by how much has come back (never OVERDUE / CANCELLED). */
export function receivableStatusFor(original: Dec, returned: Dec): "OUTSTANDING" | "PARTIALLY_RETURNED" | "FULLY_RETURNED" {
  if (returned.lte(0)) return "OUTSTANDING";
  if (returned.gte(original)) return "FULLY_RETURNED";
  return "PARTIALLY_RETURNED";
}

const MS_PER_DAY = 86_400_000;
/** Whole UTC days since the epoch — receivable dates are calendar dates, compared in UTC. */
export const utcDayNumber = (d: Date): number => Math.floor(d.getTime() / MS_PER_DAY);

/** Days from `now` until `expectedReturnAt` (negative = days overdue); null with no due date. */
export function daysUntilDue(expectedReturnAt: Date | null, now: Date): number | null {
  return expectedReturnAt ? utcDayNumber(expectedReturnAt) - utcDayNumber(now) : null;
}

const OPEN_STATUSES: ReceivableStatusName[] = ["OUTSTANDING", "PARTIALLY_RETURNED"];
export const isOpenReceivable = (status: ReceivableStatusName): boolean => OPEN_STATUSES.includes(status);

/** Persisted status, upgraded to OVERDUE at read time when an open receivable is past its due
 *  date. Due TODAY is not overdue. */
export function effectiveReceivableStatus(status: ReceivableStatusName, expectedReturnAt: Date | null, now: Date): ReceivableStatusName {
  if (!isOpenReceivable(status)) return status;
  const days = daysUntilDue(expectedReturnAt, now);
  return days !== null && days < 0 ? "OVERDUE" : status;
}

/** "Due soon" = open, not overdue, due within `withinDays` (inclusive of today). */
export function isDueSoon(status: ReceivableStatusName, expectedReturnAt: Date | null, now: Date, withinDays = 7): boolean {
  if (!isOpenReceivable(status)) return false;
  const days = daysUntilDue(expectedReturnAt, now);
  return days !== null && days >= 0 && days <= withinDays;
}

// --- Period-over-period comparison ----------------------------------------------------------

/** Change vs a previous value, in percent: (current - previous) / |previous| * 100. Null when the
 *  previous value is zero — "+∞%" is not a number worth showing, so the caller shows "new". */
export function percentChange(current: Dec, previous: Dec): Dec | null {
  return previous.isZero() ? null : current.minus(previous).div(previous.abs()).times(100);
}

/** part / whole * 100. Null when the whole is zero. */
export function percentOf(part: Dec, whole: Dec): Dec | null {
  return whole.isZero() ? null : part.div(whole).times(100);
}

// --- Contribution cadence --------------------------------------------------------------------

export type CadenceName = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

/** How many periods fit in a year. 52 / 26 / 12 / 4 / 1 — used to express any cadence per month or per year. */
export const PERIODS_PER_YEAR: Record<CadenceName, number> = { WEEKLY: 52, BIWEEKLY: 26, MONTHLY: 12, QUARTERLY: 4, YEARLY: 1 };

/** Annual contribution = amount per period x periods per year. */
export function annualContribution(amountPerPeriod: Dec, cadence: CadenceName): Dec {
  return amountPerPeriod.times(PERIODS_PER_YEAR[cadence]);
}

/** Monthly equivalent = annual contribution / 12 (a weekly ₹1,000 is ₹4,333.33 a month; a biweekly one ₹2,166.67). */
export function monthlyEquivalent(amountPerPeriod: Dec, cadence: CadenceName): Dec {
  return annualContribution(amountPerPeriod, cadence).div(12);
}

// --- Growth projection (a PROJECTION, never an actual) -----------------------------------------
//
// Deterministic compound-growth maths for "what could this become?". Everything it returns is an
// ASSUMPTION-DRIVEN projection and must be labelled PROJECTED wherever it is shown: it assumes a
// constant annual return, never overwrites any actual value, and is not a guarantee.
//
// Conventions (kept simple and stated so the numbers can be reproduced by hand):
//   * the periodic rate is the nominal annual rate / periods per year (12% a year monthly = 1% a month);
//   * the existing value and the contributions compound on that same periodic schedule;
//   * a contribution is made at the START of each period, as a SIP is debited, so it earns that
//     period's return (an annuity-due). ₹10,000 a month at 12% for 10 years is therefore ₹23,23,391
//     (contributions at the END of each month would give ₹23,00,387).

export interface GrowthProjectionInput {
  /** Value today (ACTUAL) — the starting point only; it is never changed. */
  currentValue: Dec;
  contributionPerPeriod: Dec;
  cadence: CadenceName;
  /** Assumed constant annual return, in percent (12 = 12%). */
  annualReturnPercent: Dec;
  /** Whole years ahead. */
  years: number;
  /** How many periods will actually contribute (a schedule with an end date); null = every period. */
  contributionPeriods?: number | null;
}

export interface GrowthProjection {
  years: number;
  periods: number;
  contributionPeriods: number;
  /** contributionPerPeriod x contributionPeriods — only the NEW money put in over the horizon. */
  totalContributions: Dec;
  /** What would be in the pot with no growth at all: current value + total contributions. */
  principal: Dec;
  projectedValue: Dec;
  /** projectedValue - principal: the projected growth on top of what was put in. */
  projectedGain: Dec;
}

export function projectGrowth(input: GrowthProjectionInput): GrowthProjection {
  const ppy = PERIODS_PER_YEAR[input.cadence];
  const years = Math.max(0, Math.floor(input.years));
  const periods = years * ppy;
  const contributing = Math.min(periods, Math.max(0, input.contributionPeriods ?? periods));
  const r = input.annualReturnPercent.div(100).div(ppy);

  let lump: Dec;
  let annuity: Dec;
  if (r.isZero()) {
    lump = input.currentValue;
    annuity = input.contributionPerPeriod.times(contributing);
  } else {
    const growth = (n: number) => r.plus(1).pow(n);
    lump = input.currentValue.times(growth(periods));
    // Contributions run for `contributing` periods (each made at the START of its period, hence the
    // extra (1 + r)), then the pot keeps compounding to the horizon.
    annuity = input.contributionPerPeriod.times(growth(contributing).minus(1)).div(r).times(r.plus(1)).times(growth(periods - contributing));
  }

  const totalContributions = input.contributionPerPeriod.times(contributing);
  const principal = input.currentValue.plus(totalContributions);
  const projectedValue = lump.plus(annuity);
  return { years, periods, contributionPeriods: contributing, totalContributions, principal, projectedValue, projectedGain: projectedValue.minus(principal) };
}

// --- Emergency fund target & contribution plan ----------------------------------------------
//
// Target = months x average monthly ESSENTIAL expenses (or a fixed amount). Progress, remaining and
// the contribution needed are plain arithmetic on top of the reserve balance — all in one place, so
// the page, the dashboard and the assistant can never show different numbers. Everything about the
// PLAN (required contribution, months to reach) is a planning calculation, not a recommendation.

/** Rupee target from "N months of essential expenses". Null when there is no essential-spending baseline yet. */
export function emergencyTargetFromMonths(months: Dec, avgMonthlyEssential: Dec): Dec | null {
  return avgMonthlyEssential.lte(0) ? null : months.times(avgMonthlyEssential);
}

/** What is left to reach the target (never negative: once reached, nothing remains). */
export function emergencyRemaining(target: Dec, balance: Dec): Dec {
  return Prisma.Decimal.max(target.minus(balance), new Prisma.Decimal(0));
}

/**
 * Whole periods of `daysPerPeriod` (30.4375 for a month, 7 for a week) from `now` until `targetDate`,
 * rounded UP so the plan never assumes the money arrives after the deadline. 0 when the date is today
 * or already past.
 */
export function periodsUntil(targetDate: Date, now: Date, daysPerPeriod: number): number {
  const days = utcDayNumber(targetDate) - utcDayNumber(now);
  return days <= 0 ? 0 : Math.ceil(days / daysPerPeriod);
}

/** The contribution needed each period to close `remaining` in `periods` periods. Zero when nothing remains; null with no time left. */
export function requiredContribution(remaining: Dec, periods: number): Dec | null {
  if (remaining.lte(0)) return new Prisma.Decimal(0);
  return periods > 0 ? remaining.div(periods) : null;
}

/** How many periods of `perPeriod` it takes to cover `remaining` (rounded up). Null when nothing is being contributed. */
export function periodsToReach(remaining: Dec, perPeriod: Dec): number | null {
  if (remaining.lte(0)) return 0;
  return perPeriod.lte(0) ? null : remaining.div(perPeriod).ceil().toNumber();
}

