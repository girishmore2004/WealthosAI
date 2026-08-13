import { BadRequestException } from "@nestjs/common";

// Extracted from ReportsService's private monthRange()/validateMonth() (previously
// duplicated wherever a caller needed "the UTC-safe start/end of a YYYY-MM string").
// FinancialFactsService uses this exact same logic, so "this month's actual income" is
// guaranteed to mean the identical date range everywhere it's computed — no independent
// reimplementation to silently drift out of sync with Reports' own boundary.

const MONTH_FORMAT = /^\d{4}-(0[1-9]|1[0-2])$/;

// "YYYY-MM" only. An unvalidated month string (typo, wrong separator, out-of-range month
// like "2026-13") used to fall straight into `new Date(...)`, silently producing an
// Invalid Date and a report full of zeros instead of a clear error to the caller.
export function validateMonthFormat(month?: string): void {
  if (month !== undefined && !MONTH_FORMAT.test(month)) {
    throw new BadRequestException('"month" must be in YYYY-MM format, e.g. 2026-07');
  }
}

// UTC-safe on purpose: `start` is parsed as a UTC instant, so the boundary must be
// advanced in UTC too. A local-time setMonth()/getMonth() approach is correct only when
// the server's TZ happens to be UTC — under a negative UTC-offset TZ (e.g. US Pacific),
// the local calendar date for a UTC midnight timestamp can roll back a day, silently
// shifting the whole month window.
export function monthRange(month: string): { start: Date; end: Date } {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

// "YYYY-MM" for "the current month" as of a given reference instant, in UTC — matches
// the format monthRange()/validateMonthFormat() expect. Centralized so every caller that
// currently does new Date().toISOString().slice(0, 7) computes the same string.
export function currentMonthString(reference: Date = new Date()): string {
  return reference.toISOString().slice(0, 7);
}

// Given a "YYYY-MM" month string, returns the "YYYY-MM" string for N months before it —
// used by FinancialFactsService's trailing-average forecast expense calculation. Handles
// year rollover (e.g. 3 months before "2026-01" is "2025-10").
export function monthsBefore(month: string, count: number): string {
  const [year, mo] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, mo - 1, 1));
  date.setUTCMonth(date.getUTCMonth() - count);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
