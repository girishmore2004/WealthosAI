import {
  daysInRange,
  isoDay,
  parseToday,
  previousWindow,
  resolveCustomRange,
  resolveExpensePeriod,
  sameWindowLastYear,
  startOfWeekUtc,
} from "../src/expenses/expense-period.util";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const range = (r: { from: Date; toExclusive: Date }) => [isoDay(r.from), isoDay(r.toExclusive)];

describe("expense period helpers (UTC calendar days, weeks start Monday)", () => {
  // 2026-10-04 is a SUNDAY, the awkward day for week maths.
  const sunday = d("2026-10-04");

  it("resolves day presets", () => {
    expect(range(resolveExpensePeriod("TODAY", sunday))).toEqual(["2026-10-04", "2026-10-05"]);
    expect(range(resolveExpensePeriod("YESTERDAY", sunday))).toEqual(["2026-10-03", "2026-10-04"]);
  });

  it("weeks start on Monday, so a Sunday belongs to the week that began the previous Monday", () => {
    expect(isoDay(startOfWeekUtc(sunday))).toBe("2026-09-28");
    expect(range(resolveExpensePeriod("THIS_WEEK", sunday))).toEqual(["2026-09-28", "2026-10-05"]);
    expect(range(resolveExpensePeriod("LAST_WEEK", sunday))).toEqual(["2026-09-21", "2026-09-28"]);
    expect(isoDay(startOfWeekUtc(d("2026-09-28")))).toBe("2026-09-28"); // Monday maps to itself
  });

  it("resolves month and year presets", () => {
    expect(range(resolveExpensePeriod("THIS_MONTH", sunday))).toEqual(["2026-10-01", "2026-11-01"]);
    expect(range(resolveExpensePeriod("LAST_MONTH", sunday))).toEqual(["2026-09-01", "2026-10-01"]);
    expect(range(resolveExpensePeriod("THIS_YEAR", sunday))).toEqual(["2026-01-01", "2027-01-01"]);
    expect(range(resolveExpensePeriod("LAST_YEAR", sunday))).toEqual(["2025-01-01", "2026-01-01"]);
  });

  it("LAST_MONTH in January is December of the previous year", () => {
    expect(range(resolveExpensePeriod("LAST_MONTH", d("2026-01-15")))).toEqual(["2025-12-01", "2026-01-01"]);
  });

  it("CUSTOM cannot be resolved without explicit dates", () => {
    expect(() => resolveExpensePeriod("CUSTOM", sunday)).toThrow();
  });

  it("a custom range is inclusive on BOTH ends", () => {
    const r = resolveCustomRange("2026-10-01", "2026-10-03");
    expect(range(r)).toEqual(["2026-10-01", "2026-10-04"]);
    expect(daysInRange(r)).toBe(3);
    expect(() => resolveCustomRange("2026-10-05", "2026-10-01")).toThrow();
    expect(() => resolveCustomRange("nope", "2026-10-01")).toThrow();
  });

  it("parseToday uses the caller's date, validates it, and falls back to the UTC date", () => {
    expect(isoDay(parseToday("2026-02-28"))).toBe("2026-02-28");
    expect(isoDay(parseToday(undefined, new Date("2026-10-04T23:30:00Z")))).toBe("2026-10-04");
    expect(() => parseToday("2026-13-45")).toThrow();
  });

  describe("previousWindow", () => {
    it("a whole calendar month compares with the previous calendar month (October vs September)", () => {
      expect(range(previousWindow(resolveExpensePeriod("THIS_MONTH", sunday)))).toEqual(["2026-09-01", "2026-10-01"]);
    });

    it("uses the real length of the previous month (March vs a 28-day February)", () => {
      expect(range(previousWindow({ from: d("2026-03-01"), toExclusive: d("2026-04-01") }))).toEqual(["2026-02-01", "2026-03-01"]);
    });

    it("a whole calendar year compares with the previous year", () => {
      expect(range(previousWindow(resolveExpensePeriod("THIS_YEAR", sunday)))).toEqual(["2025-01-01", "2026-01-01"]);
    });

    it("any other range compares with the same-length window immediately before it", () => {
      const r = { from: d("2026-10-10"), toExclusive: d("2026-10-15") }; // 5 days
      expect(range(previousWindow(r))).toEqual(["2026-10-05", "2026-10-10"]);
      expect(range(previousWindow(resolveExpensePeriod("THIS_WEEK", sunday)))).toEqual(["2026-09-21", "2026-09-28"]);
    });
  });

  it("sameWindowLastYear shifts both ends back one calendar year", () => {
    expect(range(sameWindowLastYear(resolveExpensePeriod("THIS_MONTH", sunday)))).toEqual(["2025-10-01", "2025-11-01"]);
  });
});
