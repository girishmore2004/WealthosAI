import { formatDay, formatMonth, localDateString } from "../dates";

describe("date helpers", () => {
  it("localDateString uses the LOCAL calendar date, not the UTC one", () => {
    // 1:00 AM local on 4 Oct: in a UTC+5:30 zone the UTC date would still be 3 Oct.
    expect(localDateString(new Date(2026, 9, 4, 1, 0, 0))).toBe("2026-10-04");
    expect(localDateString(new Date(2026, 0, 5, 23, 59, 0))).toBe("2026-01-05");
  });

  it("zero-pads month and day", () => {
    expect(localDateString(new Date(2026, 2, 7))).toBe("2026-03-07");
  });

  it("formats calendar days without shifting them by timezone", () => {
    expect(formatDay("2026-10-04")).toBe("4 Oct 2026");
    expect(formatDay("2026-10-04T00:00:00.000Z")).toBe("4 Oct 2026");
    expect(formatMonth("2026-10")).toBe("Oct 2026");
  });
});
