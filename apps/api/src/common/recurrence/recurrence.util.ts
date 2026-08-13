// PURE MODULE — no Prisma, no I/O. Computes recurrence occurrence dates only.
//
// Audit item #3 explicitly requires: "Support month-end dates such as the 28th, 29th,
// 30th, and 31st." The codebase's existing recurrence-advance logic
// (BusinessObligation's private advanceDueDate() in business.service.ts) uses
// `date.setMonth(date.getMonth() + 1)`, which does NOT handle this correctly — JS Date
// silently overflows into the following month when the target month is shorter (e.g.
// Jan 31 + 1 month naively becomes Mar 3, not Feb 28/29). This module fixes that with
// explicit last-day-of-month clamping, and is deliberately NOT reused by
// advanceDueDate() itself (a working, already-shipped, differently-scoped feature) —
// per the master preservation rules, this is new and additive, not a silent behavior
// change to existing obligation-recurrence dates.
//
// All dates are handled in UTC (matching common/utils/financial-period.util.ts's own
// UTC-safe rationale) — receivedAt/spentAt are stored as UTC instants, so advancing by
// calendar month/quarter/year must operate on UTC calendar fields, not local-server-TZ
// fields, to avoid a TZ-dependent off-by-one-day bug under a non-UTC server timezone.

import { Recurrence } from "@wealthos/db";

// Returns the last valid UTC calendar day of the given (year, monthIndex) — e.g.
// (2026, 1) [February] -> 28 for a non-leap year, 29 for a leap year. monthIndex is
// 0-indexed (0 = January), matching JS Date's own convention.
function lastDayOfUtcMonth(year: number, monthIndex: number): number {
  // Day 0 of the *next* month is the last day of *this* month — a standard, reliable
  // JS Date trick that correctly accounts for leap years automatically.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// Advances `from` by exactly one recurrence cadence, clamping to the target month's
// actual last day when `from`'s day-of-month doesn't exist there (e.g. Jan 31 -> Feb
// 28/29, not Mar 3). Returns null for ONE_TIME, which has no "next occurrence" by
// definition — callers must guard against invoking this for ONE_TIME rows.
export function nextOccurrenceDate(from: Date, recurrence: Recurrence): Date | null {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();
  const hours = from.getUTCHours();
  const minutes = from.getUTCMinutes();
  const seconds = from.getUTCSeconds();
  const ms = from.getUTCMilliseconds();

  function atMonthOffset(monthOffset: number): Date {
    const targetYear = year + Math.floor((month + monthOffset) / 12);
    const targetMonth = ((month + monthOffset) % 12 + 12) % 12;
    const clampedDay = Math.min(day, lastDayOfUtcMonth(targetYear, targetMonth));
    return new Date(Date.UTC(targetYear, targetMonth, clampedDay, hours, minutes, seconds, ms));
  }

  switch (recurrence) {
    case "WEEKLY": {
      const next = new Date(from);
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    }
    case "MONTHLY":
      return atMonthOffset(1);
    case "QUARTERLY":
      return atMonthOffset(3);
    case "YEARLY":
      return atMonthOffset(12);
    case "ONE_TIME":
    default:
      return null;
  }
}

// Computes every occurrence date from `startAfter` (exclusive) up to and including
// `upTo`, honoring an optional `endDate` (a generated occurrence must fall strictly
// before endDate) and a hard `maxOccurrences` safety cap.
//
// "Support missed periods safely" + "do not create future rows beyond a controlled
// horizon": this only ever walks FORWARD from the last known occurrence up to `upTo`
// (typically "today") — it never generates a date after `upTo`, so a template can
// never get ahead of the calendar even if the cap is set high. The cap instead guards
// against a different, real scenario: a template that sat with recurrenceActive
// dormant (or was just newly activated with an old start date) generating an
// unbounded backlog of missed occurrences in a single run.
export function computeMissedOccurrences(
  startAfter: Date,
  recurrence: Recurrence,
  upTo: Date,
  options: { endDate?: Date | null; maxOccurrences?: number } = {},
): Date[] {
  if (recurrence === "ONE_TIME") return [];

  const maxOccurrences = options.maxOccurrences ?? 24;
  const occurrences: Date[] = [];
  let cursor = startAfter;

  for (let i = 0; i < maxOccurrences; i++) {
    const next = nextOccurrenceDate(cursor, recurrence);
    if (!next) break; // ONE_TIME guard, unreachable given the check above, kept for type safety
    if (next > upTo) break; // never generate ahead of "now" — see doc comment above
    if (options.endDate && next >= options.endDate) break;

    occurrences.push(next);
    cursor = next;
  }

  return occurrences;
}
