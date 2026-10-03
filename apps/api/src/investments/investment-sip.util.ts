// Pure SIP-schedule logic: which monthly contribution periods are due, and their
// deterministic idempotency keys. No I/O.

export interface SipSchedule {
  contributionDay: number; // 1-31
  startDate: Date;
  endDate: Date | null;
}

export interface DueSipPeriod {
  periodKey: string; // "YYYY-MM" — the idempotency key component (with investmentId)
  occurredAt: Date;
}

// Hard stop so a start date years in the past can't silently generate hundreds of rows.
export const MAX_SIP_PERIODS_PER_RUN = 60;

const daysInMonthUtc = (year: number, monthIndex: number): number => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

export const sipPeriodKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * Periods whose contribution date (contributionDay, clamped to the month's length so day 31
 * becomes the 30th/28th as needed) is on/after the start date, on/before the end date, and
 * not in the future relative to `asOf`. Oldest first. Future periods are never returned: a
 * forecast must not silently become an actual.
 */
export function dueSipPeriods(schedule: SipSchedule, asOf: Date): DueSipPeriod[] {
  const out: DueSipPeriod[] = [];
  let y = schedule.startDate.getUTCFullYear();
  let m = schedule.startDate.getUTCMonth();

  while (out.length < MAX_SIP_PERIODS_PER_RUN) {
    const day = Math.min(schedule.contributionDay, daysInMonthUtc(y, m));
    const occurredAt = new Date(Date.UTC(y, m, day));
    if (occurredAt.getTime() > asOf.getTime()) break;
    if (schedule.endDate && occurredAt.getTime() > schedule.endDate.getTime()) break;
    if (occurredAt.getTime() >= Date.UTC(schedule.startDate.getUTCFullYear(), schedule.startDate.getUTCMonth(), schedule.startDate.getUTCDate())) {
      out.push({ periodKey: sipPeriodKey(occurredAt), occurredAt });
    }
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

// --- Per-type cashflow rules -------------------------------------------------------

export type InvestmentTypeName =
  | "MUTUAL_FUND" | "STOCK" | "ETF" | "EPF" | "PPF" | "NPS" | "FD" | "BOND"
  | "GOLD" | "SILVER" | "REAL_ESTATE" | "CRYPTO" | "BUSINESS_EQUITY" | "OTHER";

const INTEREST_TYPES: InvestmentTypeName[] = ["EPF", "PPF", "FD", "BOND", "NPS"];
const EMPLOYER_TYPES: InvestmentTypeName[] = ["EPF", "NPS"];
const SCHEDULE_TYPES: InvestmentTypeName[] = ["MUTUAL_FUND", "EPF", "PPF", "NPS", "ETF", "GOLD", "SILVER", "OTHER"];

/** Returns an error message when this cashflow type makes no sense for the investment type. */
export function validateCashflowForType(type: InvestmentTypeName, cashflow: string): string | null {
  if (cashflow === "EMPLOYER_CONTRIBUTION" && !EMPLOYER_TYPES.includes(type)) {
    return "Employer contributions only apply to EPF and NPS.";
  }
  if (cashflow === "INTEREST" && !INTEREST_TYPES.includes(type)) {
    return "Interest credits only apply to EPF, PPF, NPS, FD and bonds. Use a valuation for market-priced holdings.";
  }
  return null;
}

export const supportsContributionSchedule = (type: InvestmentTypeName): boolean => SCHEDULE_TYPES.includes(type);
