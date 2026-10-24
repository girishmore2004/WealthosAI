// PURE — no Prisma client, no I/O. The return maths the investment pages and the Home dashboard share:
// a real XIRR over dated cash flows, the SIP lifecycle status, and financial-year boundaries.
//
// XIRR is only reported when the data supports it. It is never substituted by a simple or annualised
// return, and it is null (with a reason) rather than NaN / Infinity / a misleading huge number.

export interface DatedFlow {
  date: Date;
  /** Negative = money the user put in, positive = money they got back (or the closing value). */
  amount: number;
}

export type XirrReason = "OK" | "NO_FLOWS" | "NEEDS_BOTH_SIGNS" | "SHORT_HISTORY" | "NOT_CONVERGED";

export interface XirrResult {
  /** Annual rate as a ratio (0.12 = 12%), or null when it cannot be computed honestly. */
  rate: number | null;
  reason: XirrReason;
}

const DAY_MS = 86_400_000;
/** An annualised rate over a few days is noise ("+4,000% a year"), so a shorter span reports nothing. */
export const MIN_XIRR_SPAN_DAYS = 30;
const MIN_RATE = -0.9999;
const MAX_RATE = 1000; // 100,000% — beyond this the answer is not meaningful
const TOLERANCE = 1e-9;

function npv(flows: DatedFlow[], t0: number, rate: number): number {
  let total = 0;
  for (const f of flows) {
    const years = (f.date.getTime() - t0) / DAY_MS / 365;
    total += f.amount / Math.pow(1 + rate, years);
  }
  return total;
}

function npvDerivative(flows: DatedFlow[], t0: number, rate: number): number {
  let total = 0;
  for (const f of flows) {
    const years = (f.date.getTime() - t0) / DAY_MS / 365;
    total += (-years * f.amount) / Math.pow(1 + rate, years + 1);
  }
  return total;
}

export function xirr(input: DatedFlow[], options: { minSpanDays?: number } = {}): XirrResult {
  const flows = input.filter((f) => Number.isFinite(f.amount) && f.amount !== 0 && !Number.isNaN(f.date.getTime()));
  if (flows.length === 0) return { rate: null, reason: "NO_FLOWS" };
  const hasOut = flows.some((f) => f.amount < 0);
  const hasIn = flows.some((f) => f.amount > 0);
  if (!hasOut || !hasIn) return { rate: null, reason: "NEEDS_BOTH_SIGNS" };

  const sorted = [...flows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const t0 = sorted[0].date.getTime();
  const spanDays = (sorted[sorted.length - 1].date.getTime() - t0) / DAY_MS;
  if (spanDays < (options.minSpanDays ?? MIN_XIRR_SPAN_DAYS)) return { rate: null, reason: "SHORT_HISTORY" };

  // Newton from a sensible guess, then bisection on a sign-changing bracket as the safe fallback.
  let rate = 0.1;
  for (let i = 0; i < 60; i++) {
    const f = npv(sorted, t0, rate);
    const d = npvDerivative(sorted, t0, rate);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = rate - f / d;
    if (!Number.isFinite(next) || next <= MIN_RATE || next > MAX_RATE) break;
    if (Math.abs(next - rate) < TOLERANCE) return { rate: next, reason: "OK" };
    rate = next;
  }

  let lo = MIN_RATE;
  let hi = MAX_RATE;
  let fLo = npv(sorted, t0, lo);
  const fHi = npv(sorted, t0, hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return { rate: null, reason: "NOT_CONVERGED" };
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(sorted, t0, mid);
    if (!Number.isFinite(fMid)) return { rate: null, reason: "NOT_CONVERGED" };
    if (Math.abs(fMid) < 1e-7 || (hi - lo) / 2 < TOLERANCE) return { rate: mid, reason: "OK" };
    if (fLo * fMid < 0) hi = mid;
    else {
      lo = mid;
      fLo = fMid;
    }
  }
  return { rate: null, reason: "NOT_CONVERGED" };
}

// --- Ledger cashflows -> XIRR flows ------------------------------------------------------------

export type LedgerType =
  | "CONTRIBUTION" | "WITHDRAWAL" | "SALE" | "DIVIDEND" | "FEE"
  | "EMPLOYER_CONTRIBUTION" | "INTEREST" | "TRANSFER_IN" | "TRANSFER_OUT";

export interface LedgerRow {
  type: LedgerType;
  amount: number;
  date: Date;
}

/**
 * Investor-perspective flows, consistent with deriveInvestmentMetrics():
 *   money in (contribution / employer / transfer-in) and fees are outflows (negative);
 *   withdrawals, sale proceeds, transfer-out and dividends are inflows (positive);
 *   INTEREST is already inside the value, so it is not a flow.
 * The closing value is appended as a final inflow at `asOf`.
 */
export function ledgerToFlows(rows: LedgerRow[], closingValue: number, asOf: Date): DatedFlow[] {
  const out: DatedFlow[] = [];
  for (const r of rows) {
    switch (r.type) {
      case "CONTRIBUTION":
      case "EMPLOYER_CONTRIBUTION":
      case "TRANSFER_IN":
      case "FEE":
        out.push({ date: r.date, amount: -r.amount });
        break;
      case "WITHDRAWAL":
      case "SALE":
      case "TRANSFER_OUT":
      case "DIVIDEND":
        out.push({ date: r.date, amount: r.amount });
        break;
      default:
        break; // INTEREST
    }
  }
  if (closingValue > 0) out.push({ date: asOf, amount: closingValue });
  return out;
}

// --- SIP lifecycle -----------------------------------------------------------------------------

export type SipStatus = "NONE" | "ACTIVE" | "PAUSED" | "CANCELLED" | "COMPLETED";

export interface SipStatusInput {
  hasSchedule: boolean;
  active: boolean;
  endDate: Date | null;
  cancelledAt: Date | null;
}

/** CANCELLED is final; a schedule past its end date is COMPLETED; otherwise active or paused. */
export function sipStatusOf(i: SipStatusInput, now: Date): SipStatus {
  if (!i.hasSchedule) return "NONE";
  if (i.cancelledAt) return "CANCELLED";
  if (i.endDate && i.endDate.getTime() < now.getTime()) return "COMPLETED";
  return i.active ? "ACTIVE" : "PAUSED";
}

// --- Financial year (India: 1 April – 31 March) --------------------------------------------------

/** Start (inclusive) of the Indian financial year containing `d`, in UTC. */
export function financialYearStart(d: Date): Date {
  const year = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return new Date(Date.UTC(year, 3, 1));
}

export function financialYearLabel(d: Date): string {
  const start = financialYearStart(d).getUTCFullYear();
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
