import {
  computePercentileSet,
  mulberry32,
  percentile,
  runMonteCarloSimulation,
  sampleNormal,
  MonteCarloAssumptions,
  MonteCarloScenarioEffect,
} from "../src/ai/scenario-studio/monte-carlo/monte-carlo.engine";

const FLAT_ASSUMPTIONS: MonteCarloAssumptions = {
  annualReturnMeanPercent: 10,
  annualReturnStdDevPercent: 0, // stddev 0 -> deterministic, every trajectory identical
  expenseInflationMeanPercent: 6,
  expenseInflationStdDevPercent: 0,
  incomeGrowthMeanPercent: 0,
  incomeGrowthStdDevPercent: 0,
  propertyAppreciationMeanPercent: 5,
  propertyAppreciationStdDevPercent: 0,
};

const VOLATILE_ASSUMPTIONS: MonteCarloAssumptions = {
  annualReturnMeanPercent: 10,
  annualReturnStdDevPercent: 15,
  expenseInflationMeanPercent: 6,
  expenseInflationStdDevPercent: 2,
  incomeGrowthMeanPercent: 3,
  incomeGrowthStdDevPercent: 4,
  propertyAppreciationMeanPercent: 5,
  propertyAppreciationStdDevPercent: 6,
};

function baseEffect(overrides: Partial<MonteCarloScenarioEffect> = {}): MonteCarloScenarioEffect {
  return {
    monthlyIncome: 100000,
    monthlyExpenses: 60000,
    monthlyInvestmentContribution: 5000,
    investmentsValue: 300000,
    loans: [],
    immediateNetWorthDelta: 0,
    ...overrides,
  };
}

describe("mulberry32 (seeded PRNG)", () => {
  it("is deterministic: the same seed produces the same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("different seeds produce different sequences", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toEqual(b());
  });

  it("always produces values in [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("sampleNormal", () => {
  it("returns exactly the mean when stdDev is 0", () => {
    const rng = mulberry32(1);
    expect(sampleNormal(rng, 10, 0, -100, 100)).toBe(10);
  });

  it("clips samples to the given [min, max] bounds", () => {
    const rng = mulberry32(1);
    // Enormous stddev forces the sample far outside any reasonable bound.
    for (let i = 0; i < 200; i++) {
      const v = sampleNormal(rng, 0, 100000, -10, 10);
      expect(v).toBeGreaterThanOrEqual(-10);
      expect(v).toBeLessThanOrEqual(10);
    }
  });
});

describe("percentile / computePercentileSet", () => {
  it("returns the single value for a one-element array", () => {
    expect(percentile([42], 50)).toBe(42);
  });

  it("returns 0 for an empty array rather than throwing or NaN", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("computes the median correctly for an odd-length sorted array", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("computePercentileSet produces p10 <= p25 <= p50 <= p75 <= p90 for any distribution", () => {
    const values = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 1000 + i);
    const set = computePercentileSet(values);
    expect(set.p10).toBeLessThanOrEqual(set.p25);
    expect(set.p25).toBeLessThanOrEqual(set.p50);
    expect(set.p50).toBeLessThanOrEqual(set.p75);
    expect(set.p75).toBeLessThanOrEqual(set.p90);
  });
});

describe("runMonteCarloSimulation", () => {
  it("is fully reproducible for a given seed — same inputs, same outputs", () => {
    const input = {
      scenarioType: "SIP_INCREASE" as const,
      horizonMonths: 60,
      iterations: 200,
      seed: 12345,
      assumptions: VOLATILE_ASSUMPTIONS,
      effect: baseEffect(),
    };
    const resultA = runMonteCarloSimulation(input);
    const resultB = runMonteCarloSimulation(input);
    expect(resultA.terminalNetWorths).toEqual(resultB.terminalNetWorths);
  });

  it("collapses to a single deterministic value across iterations when every stddev is 0", () => {
    const result = runMonteCarloSimulation({
      scenarioType: "SIP_INCREASE",
      horizonMonths: 60,
      iterations: 50,
      seed: 1,
      assumptions: FLAT_ASSUMPTIONS,
      effect: baseEffect(),
    });
    const first = result.terminalNetWorths[0];
    for (const v of result.terminalNetWorths) {
      expect(v).toBeCloseTo(first, 6);
    }
  });

  it("produces a wider terminal spread under volatile assumptions than under flat assumptions", () => {
    const flat = runMonteCarloSimulation({
      scenarioType: "SIP_INCREASE",
      horizonMonths: 60,
      iterations: 1000,
      seed: 5,
      assumptions: FLAT_ASSUMPTIONS,
      effect: baseEffect(),
    });
    const volatile = runMonteCarloSimulation({
      scenarioType: "SIP_INCREASE",
      horizonMonths: 60,
      iterations: 1000,
      seed: 5,
      assumptions: VOLATILE_ASSUMPTIONS,
      effect: baseEffect(),
    });
    const flatSet = computePercentileSet(flat.terminalNetWorths);
    const volatileSet = computePercentileSet(volatile.terminalNetWorths);
    expect(volatileSet.p90 - volatileSet.p10).toBeGreaterThan(flatSet.p90 - flatSet.p10);
  });

  it("every terminal net worth is finite — no NaN/Infinity even under wide sampling bounds", () => {
    const result = runMonteCarloSimulation({
      scenarioType: "LOAN_PREPAYMENT",
      horizonMonths: 60,
      iterations: 300,
      seed: 99,
      assumptions: VOLATILE_ASSUMPTIONS,
      effect: baseEffect({
        loans: [{ id: "loan-1", principal: 500000, annualRatePercent: 9, emi: 12000 }],
        immediateNetWorthDelta: -100000,
      }),
    });
    for (const v of result.terminalNetWorths) {
      expect(Number.isFinite(v)).toBe(true);
    }
    for (const band of result.yearlyBands) {
      expect(Number.isFinite(band.p50)).toBe(true);
    }
  });

  it("amortizes a supplied loan month-by-month rather than holding its balance flat", () => {
    const withLoan = runMonteCarloSimulation({
      scenarioType: "LOAN_PREPAYMENT",
      horizonMonths: 60,
      iterations: 100,
      seed: 3,
      assumptions: FLAT_ASSUMPTIONS,
      effect: baseEffect({ loans: [{ id: "loan-1", principal: 500000, annualRatePercent: 9, emi: 12000 }] }),
    });
    const withoutLoan = runMonteCarloSimulation({
      scenarioType: "LOAN_PREPAYMENT",
      horizonMonths: 60,
      iterations: 100,
      seed: 3,
      assumptions: FLAT_ASSUMPTIONS,
      effect: baseEffect({ loans: [] }),
    });
    // With a real loan amortizing (EMI outflow reducing idle cash each month), the
    // terminal net worth must differ from the no-loan case.
    expect(withLoan.terminalNetWorths[0]).not.toBeCloseTo(withoutLoan.terminalNetWorths[0], 2);
  });

  it("tracks and appreciates a supplied propertyValue only when provided (HOUSE_PURCHASE)", () => {
    const withProperty = runMonteCarloSimulation({
      scenarioType: "HOUSE_PURCHASE",
      horizonMonths: 60,
      iterations: 50,
      seed: 8,
      assumptions: FLAT_ASSUMPTIONS,
      effect: baseEffect({ propertyValue: 5000000 }),
    });
    const withoutProperty = runMonteCarloSimulation({
      scenarioType: "HOUSE_PURCHASE",
      horizonMonths: 60,
      iterations: 50,
      seed: 8,
      assumptions: FLAT_ASSUMPTIONS,
      effect: baseEffect(),
    });
    // A tracked, appreciating property is a strictly positive asset addition —
    // terminal net worth with it must exceed terminal net worth without it, all else
    // held equal (same seed, same flat assumptions).
    expect(withProperty.terminalNetWorths[0]).toBeGreaterThan(withoutProperty.terminalNetWorths[0]);
  });

  it("produces yearly bands covering the full horizon, with the final month always included", () => {
    const result = runMonteCarloSimulation({
      scenarioType: "SIP_INCREASE",
      horizonMonths: 60,
      iterations: 100,
      seed: 2,
      assumptions: VOLATILE_ASSUMPTIONS,
      effect: baseEffect(),
    });
    const lastBand = result.yearlyBands[result.yearlyBands.length - 1];
    expect(lastBand.monthIndex).toBe(60);
    // Bands are ordered by increasing month index.
    for (let i = 1; i < result.yearlyBands.length; i++) {
      expect(result.yearlyBands[i].monthIndex).toBeGreaterThan(result.yearlyBands[i - 1].monthIndex);
    }
  });
});
