// Pure SIP-schedule logic: which contribution periods are due, and their deterministic
// idempotency keys. No I/O.
//
// Cadences: MONTHLY (the original, and the default), plus WEEKLY, BIWEEKLY, QUARTERLY and YEARLY.
//   MONTHLY / QUARTERLY / YEARLY  step by calendar months from the start month and fall on
//                                 `contributionDay` (clamped to the month's length).
//   WEEKLY / BIWEEKLY             step by 7 / 14 days from the start DATE (contributionDay is unused).
// Period keys, the idempotency component (with investmentId + CONTRIBUTION):
//   MONTHLY "2026-09" (unchanged, so existing schedules keep their keys) · QUARTERLY "2026-Q3" ·
//   YEARLY "2026" · WEEKLY / BIWEEKLY the occurrence date "2026-09-14".

export type SipFrequency = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

export interface SipSchedule {
  contributionDay: number; // 1-31 (ignored for WEEKLY / BIWEEKLY)
  startDate: Date;
  endDate: Date | null;
  frequency?: SipFrequency; // default MONTHLY
}

export interface DueSipPeriod {
  periodKey: string; // the idempotency key component (with investmentId)
  occurredAt: Date;
}

// Hard stop so a start date years in the past can't silently generate hundreds of rows in one run.
// 60 is the original monthly cap and is unchanged; other cadences get a proportionate cap.
export const MAX_SIP_PERIODS_PER_RUN = 60;
const MAX_PERIODS_BY_FREQUENCY: Record<SipFrequency, number> = { WEEKLY: 260, BIWEEKLY: 130, MONTHLY: MAX_SIP_PERIODS_PER_RUN, QUARTERLY: 20, YEARLY: 10 };
export const maxPeriodsPerRun = (f: SipFrequency): number => MAX_PERIODS_BY_FREQUENCY[f];

const DAY_MS = 86_400_000;
const STEP_MONTHS: Partial<Record<SipFrequency, number>> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };
const STEP_DAYS: Partial<Record<SipFrequency, number>> = { WEEKLY: 7, BIWEEKLY: 14 };

const daysInMonthUtc = (year: number, monthIndex: number): number => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
const pad = (n: number): string => String(n).padStart(2, "0");
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const startOfDayUtc = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Monthly period key, "YYYY-MM" — unchanged (kept for existing callers and existing rows). */
export const sipPeriodKey = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;

/** The idempotency period key for a contribution dated `d` under the given cadence. */
export function sipPeriodKeyFor(frequency: SipFrequency, d: Date): string {
  switch (frequency) {
    case "QUARTERLY":
      return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case "YEARLY":
      return `${d.getUTCFullYear()}`;
    case "WEEKLY":
    case "BIWEEKLY":
      return isoDay(d);
    case "MONTHLY":
    default:
      return sipPeriodKey(d);
  }
}

/** The k-th scheduled date (k = 0, 1, 2 …) before any start/end filtering. */
function scheduledDate(schedule: SipSchedule, k: number): Date {
  const frequency = schedule.frequency ?? "MONTHLY";
  const stepDays = STEP_DAYS[frequency];
  if (stepDays) return new Date(startOfDayUtc(schedule.startDate) + k * stepDays * DAY_MS);

  const step = STEP_MONTHS[frequency] ?? 1;
  const monthIndex = schedule.startDate.getUTCMonth() + k * step;
  const y = schedule.startDate.getUTCFullYear() + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  return new Date(Date.UTC(y, m, Math.min(schedule.contributionDay, daysInMonthUtc(y, m))));
}

// Safety bound on how far any enumeration may walk (100 years of weekly dates is 5,200).
const MAX_WALK = 20_000;

/**
 * Scheduled dates on/after the start date and on/before the end date, in order, that fall after
 * `after` (exclusive) and on/before `upTo`, at most `limit` of them. Future dates are never
 * returned past `upTo`: a forecast must not silently become an actual.
 */
export function sipOccurrences(schedule: SipSchedule, upTo: Date, options: { after?: Date | null; limit?: number } = {}): Date[] {
  const limit = options.limit ?? MAX_WALK;
  const startDay = startOfDayUtc(schedule.startDate);
  const out: Date[] = [];
  for (let k = 0; k < MAX_WALK && out.length < limit; k++) {
    const occurredAt = scheduledDate(schedule, k);
    if (occurredAt.getTime() > upTo.getTime()) break;
    if (schedule.endDate && occurredAt.getTime() > schedule.endDate.getTime()) break;
    if (occurredAt.getTime() < startDay) continue; // e.g. day 5 of a month the schedule starts on the 20th
    if (options.after && occurredAt.getTime() <= options.after.getTime()) continue;
    out.push(occurredAt);
  }
  return out;
}

/**
 * Periods due as of `asOf`, oldest first.
 *
 * Ordinary schedules (fewer due periods than the per-run cap) are enumerated from the START every
 * time, exactly as before: generation is idempotent by period key, so any gap (a contribution the
 * user deleted, an older start date) is simply filled again.
 *
 * Only a schedule LONGER than the cap needs the `after` cursor. Without it the cap would always
 * select the OLDEST periods, so a schedule running longer than the cap (60 months for a monthly
 * SIP) would regenerate the same first N periods forever and never create the newest ones. With
 * it, a capped run resumes after the latest period already generated.
 */
export function dueSipPeriods(schedule: SipSchedule, asOf: Date, options: { after?: Date | null } = {}): DueSipPeriod[] {
  const frequency = schedule.frequency ?? "MONTHLY";
  const cap = maxPeriodsPerRun(frequency);
  let occurrences = sipOccurrences(schedule, asOf, { limit: cap });
  if (occurrences.length >= cap && options.after) {
    occurrences = sipOccurrences(schedule, asOf, { after: options.after, limit: cap });
  }
  return occurrences.map((occurredAt) => ({ periodKey: sipPeriodKeyFor(frequency, occurredAt), occurredAt }));
}

/** The first scheduled date on/after `from` (a calendar day), or null once the schedule has ended. */
export function nextSipOccurrence(schedule: SipSchedule, from: Date): Date | null {
  const fromDay = startOfDayUtc(from);
  const startDay = startOfDayUtc(schedule.startDate);
  for (let k = 0; k < MAX_WALK; k++) {
    const occurredAt = scheduledDate(schedule, k);
    if (schedule.endDate && occurredAt.getTime() > schedule.endDate.getTime()) return null;
    if (occurredAt.getTime() < startDay || occurredAt.getTime() < fromDay) continue;
    return occurredAt;
  }
  return null;
}

/** How many scheduled dates fall on/before `upTo` (within the start/end window). */
export const countSipOccurrences = (schedule: SipSchedule, upTo: Date): number => sipOccurrences(schedule, upTo).length;

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
