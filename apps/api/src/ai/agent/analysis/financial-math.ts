// Deterministic arithmetic for the agent's analysis layer. Nothing in here calls a model, reads the database or has side
// effects, so every figure the agent reports can be reproduced and unit-tested. Money is summed in integer paise so
// that 0.1 + 0.2 style drift can never put a total out by a rupee.

export type Cadence = "ONE_TIME" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

export const PAISE = 100;

export const toPaise = (rupees: number): number => Math.round(rupees * PAISE);
export const fromPaise = (paise: number): number => paise / PAISE;
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Exact (paise-based) sum of rupee amounts. Non-finite values are ignored rather than poisoning the total. */
export function sumMoney(values: readonly number[]): number {
  let paise = 0;
  for (const v of values) if (Number.isFinite(v)) paise += toPaise(v);
  return fromPaise(paise);
}

const PERIODS_PER_YEAR: Record<Cadence, number> = { ONE_TIME: 1, WEEKLY: 52, BIWEEKLY: 26, MONTHLY: 12, QUARTERLY: 4, YEARLY: 1 };

export function periodsPerYear(cadence: string): number | null {
  return (PERIODS_PER_YEAR as Record<string, number>)[cadence] ?? null;
}

/** Yearly cost of an amount that recurs at `cadence`. A ONE_TIME amount counts once. Unknown cadence → null (never guessed). */
export function annualise(amount: number, cadence: string): number | null {
  const n = periodsPerYear(cadence);
  return n === null ? null : round2(amount * n);
}

/** Monthly equivalent of an amount that recurs at `cadence`. */
export function monthlyEquivalent(amount: number, cadence: string): number | null {
  const a = annualise(amount, cadence);
  return a === null ? null : round2(a / 12);
}

export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round2(((current - previous) / Math.abs(previous)) * 100);
}

export function ratioPercent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return null;
  return round2((part / whole) * 100);
}

// --- robust statistics ------------------------------------------------------------------------------------------------

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Median absolute deviation about the median. */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Iglewicz–Hoaglin modified z-score. When MAD is 0 (most values identical) the mean absolute deviation is used instead,
 * as recommended for that case, so a repeated identical amount does not make every other value "infinitely" unusual. */
export function robustZ(x: number, xs: readonly number[]): number {
  const m = median(xs);
  const d = mad(xs);
  if (d > 0) return (0.6745 * (x - m)) / d;
  const meanAbs = mean(xs.map((v) => Math.abs(v - m)));
  if (meanAbs > 0) return (x - m) / (1.253314 * meanAbs);
  return 0;
}

export function coefficientOfVariation(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const mu = mean(xs);
  if (mu === 0) return null;
  const variance = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance) / Math.abs(mu);
}

// --- reconciliation ---------------------------------------------------------------------------------------------------

export interface TotalReconciliation {
  calculatedTotal: number;
  reportedTotal: number;
  difference: number; // reported - calculated
  reconciles: boolean;
}

/** Compares a reported total with the exact sum of its components. Tolerance is in rupees (default: one rupee of rounding). */
export function reconcileTotal(components: readonly number[], reportedTotal: number, toleranceRupees = 1): TotalReconciliation {
  const calculatedTotal = sumMoney(components);
  const difference = round2(reportedTotal - calculatedTotal);
  return { calculatedTotal, reportedTotal: round2(reportedTotal), difference, reconciles: Math.abs(difference) <= toleranceRupees };
}

// --- growth -----------------------------------------------------------------------------------------------------------

/** Future value of a lump sum plus a level monthly contribution paid at the end of each month, compounded monthly. */
export function futureValue(presentValue: number, monthlyContribution: number, annualReturnPercent: number, years: number): number {
  const n = Math.max(0, Math.round(years * 12));
  const r = annualReturnPercent / 100 / 12;
  if (r === 0) return round2(presentValue + monthlyContribution * n);
  const growth = Math.pow(1 + r, n);
  return round2(presentValue * growth + monthlyContribution * ((growth - 1) / r));
}

/** Today's-money value of a future amount. */
export function deflate(futureAmount: number, annualInflationPercent: number, years: number): number {
  const f = Math.pow(1 + annualInflationPercent / 100, years);
  return f === 0 ? futureAmount : round2(futureAmount / f);
}
