import { formatINR, formatPercent } from "../format";

describe("formatINR", () => {
  it("formats a number using Indian digit grouping (lakh/crore style)", () => {
    expect(formatINR(1245000)).toBe("₹12,45,000");
  });

  it("parses a decimal string (as returned by the API) the same way as a number", () => {
    expect(formatINR("1245000.00")).toBe("₹12,45,000");
  });

  it("rounds to the nearest rupee rather than showing decimals", () => {
    expect(formatINR(999.6)).toBe("₹1,000");
  });

  it("can omit the ₹ symbol when explicitly asked", () => {
    expect(formatINR(5000, { showSymbol: false })).toBe("5,000");
  });

  it("handles zero without a leading garbage character", () => {
    expect(formatINR(0)).toBe("₹0");
  });
});

describe("formatPercent", () => {
  it("formats to exactly one decimal place with a trailing %", () => {
    expect(formatPercent(12.345)).toBe("12.3%");
  });

  it("handles a whole number cleanly", () => {
    expect(formatPercent(50)).toBe("50.0%");
  });

  it("handles a negative percent (e.g. investment loss) correctly", () => {
    expect(formatPercent(-8.2)).toBe("-8.2%");
  });
});
