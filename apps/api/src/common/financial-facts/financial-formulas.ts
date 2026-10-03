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
