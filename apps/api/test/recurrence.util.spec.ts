import { nextOccurrenceDate, computeMissedOccurrences } from "../src/common/recurrence/recurrence.util";

describe("nextOccurrenceDate", () => {
  it("returns null for ONE_TIME — no next occurrence by definition", () => {
    expect(nextOccurrenceDate(new Date("2026-01-15T00:00:00.000Z"), "ONE_TIME")).toBeNull();
  });

  it("advances WEEKLY by exactly 7 days", () => {
    const next = nextOccurrenceDate(new Date("2026-01-15T00:00:00.000Z"), "WEEKLY");
    expect(next?.toISOString()).toBe("2026-01-22T00:00:00.000Z");
  });

  it("advances MONTHLY on a normal (non-month-end) day", () => {
    const next = nextOccurrenceDate(new Date("2026-01-15T00:00:00.000Z"), "MONTHLY");
    expect(next?.toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });

  it("advances QUARTERLY by exactly 3 months", () => {
    const next = nextOccurrenceDate(new Date("2026-01-15T00:00:00.000Z"), "QUARTERLY");
    expect(next?.toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });

  it("advances YEARLY by exactly 1 year", () => {
    const next = nextOccurrenceDate(new Date("2026-01-15T00:00:00.000Z"), "YEARLY");
    expect(next?.toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });

  // --- Month-end clamping (audit item #3's explicit requirement) -----------------

  it("clamps Jan 31 -> Feb 28 in a non-leap year (audit item #3)", () => {
    const next = nextOccurrenceDate(new Date("2026-01-31T00:00:00.000Z"), "MONTHLY");
    expect(next?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    // Explicitly confirms this is NOT the naive JS Date overflow (which would land on
    // Mar 3, 2026 for setMonth-based arithmetic on Jan 31 across a 28-day February).
    expect(next?.getUTCMonth()).toBe(1); // February, not March
  });

  it("clamps Jan 31 -> Feb 29 in a leap year", () => {
    const next = nextOccurrenceDate(new Date("2028-01-31T00:00:00.000Z"), "MONTHLY");
    expect(next?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("clamps Mar 31 -> Apr 30 (30-day month)", () => {
    const next = nextOccurrenceDate(new Date("2026-03-31T00:00:00.000Z"), "MONTHLY");
    expect(next?.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("does NOT clamp when the day already exists in the target month", () => {
    const next = nextOccurrenceDate(new Date("2026-03-28T00:00:00.000Z"), "MONTHLY");
    expect(next?.toISOString()).toBe("2026-04-28T00:00:00.000Z");
  });

  it("clamps correctly across a year boundary (Dec 31 -> Jan 31, then repeats to Feb 28)", () => {
    const first = nextOccurrenceDate(new Date("2026-12-31T00:00:00.000Z"), "MONTHLY");
    expect(first?.toISOString()).toBe("2027-01-31T00:00:00.000Z");
    const second = nextOccurrenceDate(first as Date, "MONTHLY");
    expect(second?.toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });

  it("clamps for QUARTERLY landing on a short month (e.g. Nov 30 + 3 -> Feb 28/29)", () => {
    const next = nextOccurrenceDate(new Date("2025-11-30T00:00:00.000Z"), "QUARTERLY");
    expect(next?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("preserves time-of-day across the advance", () => {
    const next = nextOccurrenceDate(new Date("2026-01-15T13:45:30.500Z"), "MONTHLY");
    expect(next?.toISOString()).toBe("2026-02-15T13:45:30.500Z");
  });
});

describe("computeMissedOccurrences", () => {
  it("returns an empty array for ONE_TIME regardless of the date range", () => {
    const occurrences = computeMissedOccurrences(
      new Date("2026-01-01T00:00:00.000Z"),
      "ONE_TIME",
      new Date("2026-12-01T00:00:00.000Z"),
    );
    expect(occurrences).toEqual([]);
  });

  it("generates every missed MONTHLY occurrence between the template date and now", () => {
    const occurrences = computeMissedOccurrences(
      new Date("2026-01-15T00:00:00.000Z"),
      "MONTHLY",
      new Date("2026-04-20T00:00:00.000Z"),
    );
    expect(occurrences.map((d) => d.toISOString())).toEqual([
      "2026-02-15T00:00:00.000Z",
      "2026-03-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
    ]);
  });

  it("never generates an occurrence after `upTo`, even if more would technically be due", () => {
    const occurrences = computeMissedOccurrences(
      new Date("2026-01-15T00:00:00.000Z"),
      "MONTHLY",
      new Date("2026-02-20T00:00:00.000Z"),
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });

  it("stops before an occurrence that would fall on or after the given endDate", () => {
    const occurrences = computeMissedOccurrences(
      new Date("2026-01-15T00:00:00.000Z"),
      "MONTHLY",
      new Date("2026-06-01T00:00:00.000Z"),
      { endDate: new Date("2026-03-15T00:00:00.000Z") },
    );
    // Feb 15 is before the end date; Mar 15 is not strictly before it, so it's excluded.
    expect(occurrences.map((d) => d.toISOString())).toEqual(["2026-02-15T00:00:00.000Z"]);
  });

  it("caps at maxOccurrences even if far more are technically due (dormant-template safety)", () => {
    const occurrences = computeMissedOccurrences(
      new Date("2020-01-01T00:00:00.000Z"),
      "MONTHLY",
      new Date("2026-01-01T00:00:00.000Z"),
      { maxOccurrences: 5 },
    );
    expect(occurrences).toHaveLength(5);
  });

  it("defaults to a cap of 24 occurrences when none is specified", () => {
    const occurrences = computeMissedOccurrences(
      new Date("2010-01-01T00:00:00.000Z"),
      "MONTHLY",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(occurrences).toHaveLength(24);
  });

  it("returns an empty array when nothing is due yet", () => {
    const occurrences = computeMissedOccurrences(
      new Date("2026-01-15T00:00:00.000Z"),
      "MONTHLY",
      new Date("2026-01-20T00:00:00.000Z"),
    );
    expect(occurrences).toEqual([]);
  });

  it("correctly chains month-end clamping across multiple generated occurrences", () => {
    const occurrences = computeMissedOccurrences(
      new Date("2026-01-31T00:00:00.000Z"),
      "MONTHLY",
      new Date("2026-05-01T00:00:00.000Z"),
    );
    expect(occurrences.map((d) => d.toISOString())).toEqual([
      "2026-02-28T00:00:00.000Z",
      "2026-03-28T00:00:00.000Z", // clamped-then-normal-31st behavior: once clamped to
      // the 28th, subsequent months advance from the 28th, not snapping back to 31 —
      // documented, intentional "sticky clamp" behavior matching how real-world
      // billing cycles for a "31st of the month" subscription actually settle once
      // they've been clamped by a short February.
      "2026-04-28T00:00:00.000Z",
    ]);
  });
});
