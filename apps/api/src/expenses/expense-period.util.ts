import { BadRequestException } from "@nestjs/common";

// Pure date-range helpers for expense filters and analytics. Everything is a UTC CALENDAR DAY:
// an expense's date is stored as the day the user entered (midnight UTC), so day/week/month
// buckets must be computed in UTC too or a late-evening expense would land on the wrong day.
// Weeks start on MONDAY. Ranges are half-open: [from, toExclusive).

export type ExpensePeriod =
  | "TODAY"
  | "YESTERDAY"
  | "THIS_WEEK"
  | "LAST_WEEK"
  | "THIS_MONTH"
  | "LAST_MONTH"
  | "THIS_YEAR"
  | "LAST_YEAR"
  | "CUSTOM";

export interface DateRange {
  from: Date;
  toExclusive: Date;
}

export const DAY_MS = 86_400_000;

/** Midnight UTC of the calendar day containing `d`. */
export const utcMidnight = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const addDaysUtc = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);

/** The caller's "today" as a UTC-midnight Date. Falls back to the server's UTC date. */
export function parseToday(today?: string, now: Date = new Date()): Date {
  if (!today) return utcMidnight(now);
  const d = new Date(`${today}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException("today must be a valid YYYY-MM-DD date");
  return d;
}

/** Monday of the week containing `d` (UTC). */
export function startOfWeekUtc(d: Date): Date {
  const day = utcMidnight(d);
  const isoWeekday = (day.getUTCDay() + 6) % 7; // Monday = 0 … Sunday = 6
  return addDaysUtc(day, -isoWeekday);
}

const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1));

export function resolveExpensePeriod(period: ExpensePeriod, today: Date): DateRange {
  const t = utcMidnight(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  switch (period) {
    case "TODAY":
      return { from: t, toExclusive: addDaysUtc(t, 1) };
    case "YESTERDAY":
      return { from: addDaysUtc(t, -1), toExclusive: t };
    case "THIS_WEEK": {
      const from = startOfWeekUtc(t);
      return { from, toExclusive: addDaysUtc(from, 7) };
    }
    case "LAST_WEEK": {
      const thisWeek = startOfWeekUtc(t);
      return { from: addDaysUtc(thisWeek, -7), toExclusive: thisWeek };
    }
    case "THIS_MONTH":
      return { from: monthStart(y, m), toExclusive: monthStart(y, m + 1) };
    case "LAST_MONTH":
      return { from: monthStart(y, m - 1), toExclusive: monthStart(y, m) };
    case "THIS_YEAR":
      return { from: monthStart(y, 0), toExclusive: monthStart(y + 1, 0) };
    case "LAST_YEAR":
      return { from: monthStart(y - 1, 0), toExclusive: monthStart(y, 0) };
    default:
      throw new BadRequestException("A CUSTOM period needs explicit from and to dates");
  }
}

/** A custom [from, to] pair where BOTH ends are inclusive calendar days → half-open range. */
export function resolveCustomRange(from: string, to: string): DateRange {
  const f = new Date(from);
  const t = new Date(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new BadRequestException("Invalid from/to date");
  const range = { from: utcMidnight(f), toExclusive: addDaysUtc(utcMidnight(t), 1) };
  if (range.toExclusive.getTime() <= range.from.getTime()) throw new BadRequestException("to must not be before from");
  return range;
}

export const daysInRange = (r: DateRange): number => Math.round((r.toExclusive.getTime() - r.from.getTime()) / DAY_MS);

const isMonthStart = (d: Date) => d.getUTCDate() === 1;
const isYearStart = (d: Date) => isMonthStart(d) && d.getUTCMonth() === 0;

/**
 * The window to compare against: a whole calendar month compares with the previous calendar month
 * (October vs September, not "31 days earlier"), a whole calendar year with the previous year, and
 * any other range with the same-length window immediately before it.
 */
export function previousWindow(r: DateRange): DateRange {
  const nextMonth = monthStart(r.from.getUTCFullYear(), r.from.getUTCMonth() + 1);
  if (isMonthStart(r.from) && r.toExclusive.getTime() === nextMonth.getTime()) {
    return { from: monthStart(r.from.getUTCFullYear(), r.from.getUTCMonth() - 1), toExclusive: r.from };
  }
  const nextYear = monthStart(r.from.getUTCFullYear() + 1, 0);
  if (isYearStart(r.from) && r.toExclusive.getTime() === nextYear.getTime()) {
    return { from: monthStart(r.from.getUTCFullYear() - 1, 0), toExclusive: r.from };
  }
  const len = r.toExclusive.getTime() - r.from.getTime();
  return { from: new Date(r.from.getTime() - len), toExclusive: r.from };
}

/** The same window one calendar year earlier (for a year-over-year comparison). */
export function sameWindowLastYear(r: DateRange): DateRange {
  const shift = (d: Date) => new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()));
  return { from: shift(r.from), toExclusive: shift(r.toExclusive) };
}

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
