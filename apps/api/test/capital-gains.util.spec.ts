import {
  classifyGainCategory,
  summarizeCapitalGains,
  CapitalGainsExcludedTypeError,
  EQUITY_LTCG_ANNUAL_EXEMPTION,
  EQUITY_STCG_RATE,
  EQUITY_LTCG_RATE,
  CRYPTO_TAX_RATE,
  OTHER_LTCG_RATE,
} from "../src/tax/capital-gains.util";

describe("classifyGainCategory", () => {
  it.each(["STOCK", "ETF", "MUTUAL_FUND"] as const)(
    "classifies %s held for exactly 365 days as SHORT_TERM (threshold is exclusive)",
    (type) => {
      expect(classifyGainCategory(type, 365)).toBe("EQUITY_SHORT_TERM");
    },
  );

  it.each(["STOCK", "ETF", "MUTUAL_FUND"] as const)("classifies %s held for 366 days as LONG_TERM", (type) => {
    expect(classifyGainCategory(type, 366)).toBe("EQUITY_LONG_TERM");
  });

  it("always classifies CRYPTO as CRYPTO regardless of holding period", () => {
    expect(classifyGainCategory("CRYPTO", 1)).toBe("CRYPTO");
    expect(classifyGainCategory("CRYPTO", 10000)).toBe("CRYPTO");
  });

  it.each(["GOLD", "SILVER", "REAL_ESTATE", "BOND", "BUSINESS_EQUITY", "OTHER"] as const)(
    "classifies %s held for exactly 730 days as SHORT_TERM (24-month threshold is exclusive)",
    (type) => {
      expect(classifyGainCategory(type, 730)).toBe("OTHER_SHORT_TERM");
    },
  );

  it.each(["GOLD", "SILVER", "REAL_ESTATE", "BOND", "BUSINESS_EQUITY", "OTHER"] as const)(
    "classifies %s held for 731 days as LONG_TERM",
    (type) => {
      expect(classifyGainCategory(type, 731)).toBe("OTHER_LONG_TERM");
    },
  );

  it.each(["EPF", "PPF", "NPS", "FD"] as const)("throws CapitalGainsExcludedTypeError for %s", (type) => {
    expect(() => classifyGainCategory(type, 1000)).toThrow(CapitalGainsExcludedTypeError);
  });
});

describe("summarizeCapitalGains", () => {
  it("computes equity STCG at a flat 20% with no exemption", () => {
    const result = summarizeCapitalGains([{ category: "EQUITY_SHORT_TERM", gainAmount: 100000 }]);
    expect(result.equityShortTermGain).toBe(100000);
    expect(result.equityShortTermTax).toBeCloseTo(100000 * EQUITY_STCG_RATE, 2);
  });

  it("applies the ₹1,25,000 annual exemption to equity LTCG before taxing the excess at 12.5%", () => {
    const result = summarizeCapitalGains([{ category: "EQUITY_LONG_TERM", gainAmount: 300000 }]);
    expect(result.equityLongTermExemptionUsed).toBe(EQUITY_LTCG_ANNUAL_EXEMPTION);
    const taxableExcess = 300000 - EQUITY_LTCG_ANNUAL_EXEMPTION;
    expect(result.equityLongTermTax).toBeCloseTo(taxableExcess * EQUITY_LTCG_RATE, 2);
  });

  it("owes zero equity LTCG tax when the gain is entirely within the exemption", () => {
    const result = summarizeCapitalGains([{ category: "EQUITY_LONG_TERM", gainAmount: 100000 }]);
    expect(result.equityLongTermExemptionUsed).toBe(100000);
    expect(result.equityLongTermTax).toBe(0);
  });

  it("nets multiple equity LTCG events (a loss offsetting a gain) before applying the exemption", () => {
    const result = summarizeCapitalGains([
      { category: "EQUITY_LONG_TERM", gainAmount: 300000 },
      { category: "EQUITY_LONG_TERM", gainAmount: -50000 },
    ]);
    expect(result.equityLongTermGain).toBe(250000);
    const taxableExcess = 250000 - EQUITY_LTCG_ANNUAL_EXEMPTION;
    expect(result.equityLongTermTax).toBeCloseTo(taxableExcess * EQUITY_LTCG_RATE, 2);
  });

  it("owes zero tax (not negative) when net equity gains are a loss overall", () => {
    const result = summarizeCapitalGains([
      { category: "EQUITY_SHORT_TERM", gainAmount: 10000 },
      { category: "EQUITY_SHORT_TERM", gainAmount: -50000 },
    ]);
    expect(result.equityShortTermGain).toBe(-40000);
    expect(result.equityShortTermTax).toBe(0);
  });

  it("taxes crypto gains at a flat 30%", () => {
    const result = summarizeCapitalGains([{ category: "CRYPTO", gainAmount: 200000 }]);
    expect(result.cryptoGain).toBe(200000);
    expect(result.cryptoTax).toBeCloseTo(200000 * CRYPTO_TAX_RATE, 2);
  });

  it("does NOT let a crypto loss offset a crypto gain — tracks it as a separate disallowed figure instead", () => {
    const result = summarizeCapitalGains([
      { category: "CRYPTO", gainAmount: 200000 },
      { category: "CRYPTO", gainAmount: -80000 },
    ]);
    // Real rule: crypto losses cannot offset ANYTHING, not even other crypto gains.
    expect(result.cryptoGain).toBe(200000); // unaffected by the loss
    expect(result.cryptoTax).toBeCloseTo(200000 * CRYPTO_TAX_RATE, 2); // taxed as if the loss didn't happen
    expect(result.cryptoLossDisallowed).toBe(80000);
  });

  it("taxes other-asset LTCG at a flat 12.5% with no exemption", () => {
    const result = summarizeCapitalGains([{ category: "OTHER_LONG_TERM", gainAmount: 500000 }]);
    expect(result.otherLongTermGain).toBe(500000);
    expect(result.otherLongTermTax).toBeCloseTo(500000 * OTHER_LTCG_RATE, 2);
  });

  it("does not compute otherShortTermTax — that's TaxService's responsibility (needs total taxable income)", () => {
    const result = summarizeCapitalGains([{ category: "OTHER_SHORT_TERM", gainAmount: 100000 }]);
    expect(result.otherShortTermGain).toBe(100000);
    expect((result as any).otherShortTermTax).toBeUndefined();
  });

  it("returns all-zero figures for an empty event list", () => {
    const result = summarizeCapitalGains([]);
    expect(result.equityShortTermTax).toBe(0);
    expect(result.equityLongTermTax).toBe(0);
    expect(result.cryptoTax).toBe(0);
    expect(result.otherLongTermTax).toBe(0);
    expect(result.cryptoLossDisallowed).toBe(0);
  });

  it("keeps every category's totals independent — a loss in one category never offsets a gain in another", () => {
    const result = summarizeCapitalGains([
      { category: "EQUITY_SHORT_TERM", gainAmount: -100000 },
      { category: "EQUITY_LONG_TERM", gainAmount: 200000 },
    ]);
    expect(result.equityShortTermTax).toBe(0); // the loss doesn't reduce this
    const taxableExcess = 200000 - EQUITY_LTCG_ANNUAL_EXEMPTION;
    expect(result.equityLongTermTax).toBeCloseTo(taxableExcess * EQUITY_LTCG_RATE, 2); // unaffected by the ST loss
  });
});
