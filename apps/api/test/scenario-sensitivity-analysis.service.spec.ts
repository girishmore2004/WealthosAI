import { SensitivityAnalysisService } from "../src/ai/scenario-studio/sensitivity/sensitivity-analysis.service";
import { RunScenarioResponseDTO } from "@wealthos/types";

function makeBaseRun(overrides: Partial<RunScenarioResponseDTO["baseline"]> = {}): RunScenarioResponseDTO {
  return {
    baseline: {
      monthlyIncome: 100000,
      monthlyExpenses: 60000,
      netWorth: 500000,
      investmentsValue: 300000,
      totalDebt: 200000,
      currentAge: 30,
      targetRetirementAge: 60,
      ...overrides,
    },
    result: {
      scenarioType: "SIP_INCREASE",
      monthlyCashflowDelta: "0.00",
      netWorthDeltaIn5Years: "10000.00",
      projectedNetWorthIn5Years: "600000.00",
      goalImpact: "",
      assumptions: [],
      narrative: "",
      isProjectionOnly: true,
    },
  };
}

describe("SensitivityAnalysisService", () => {
  it("sweeps the scenario's own primary field across the documented multiplier steps", async () => {
    const baseRun = makeBaseRun();
    const mockSimulator = { run: jest.fn().mockResolvedValue(baseRun) };
    const service = new SensitivityAnalysisService(mockSimulator as never);

    const dimensions = await service.analyze("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 5000 }, baseRun);
    const primary = dimensions.find((d) => d.field === "additionalMonthlyAmount")!;

    expect(primary.points).toHaveLength(5); // SENSITIVITY_MULTIPLIERS has 5 steps
    expect(primary.points.map((p) => p.paramValue)).toEqual([2500, 3750, 5000, 6250, 7500]);
    expect(mockSimulator.run).toHaveBeenCalledTimes(5);
  });

  it("sweeps RETIREMENT_AGE_SHIFT's age field using additive deltas, not multipliers", async () => {
    const baseRun = makeBaseRun();
    const mockSimulator = { run: jest.fn().mockResolvedValue(baseRun) };
    const service = new SensitivityAnalysisService(mockSimulator as never);

    const dimensions = await service.analyze("user-1", "RETIREMENT_AGE_SHIFT", { newRetirementAge: 60 }, baseRun);
    const primary = dimensions.find((d) => d.field === "newRetirementAge")!;

    expect(primary.points.map((p) => p.paramValue)).toEqual([55, 58, 60, 62, 65]); // 60 + [-5,-2,0,2,5]
  });

  it("the return-rate sweep uses the engine's month-by-month path with the baseline's real loans, not the flat-debt fallback", async () => {
    const baseRun = makeBaseRun({
      loans: [{ id: "loan-1", principal: 200000, annualRatePercent: 8.5, emi: 4500 }],
    });
    const mockSimulator = { run: jest.fn().mockResolvedValue(baseRun) };
    const service = new SensitivityAnalysisService(mockSimulator as never);

    const dimensions = await service.analyze("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 5000 }, baseRun);
    const returnRateDimension = dimensions.find((d) => d.field === "annualReturnPercent")!;

    expect(returnRateDimension.points).toHaveLength(5); // RETURN_RATE_SENSITIVITY_PERCENTS has 5 steps
    expect(returnRateDimension.points.map((p) => p.paramValue)).toEqual([6, 8, 10, 12, 14]);
    // Every point must be finite — the amortizing/inflating month-by-month path must
    // not blow up even for a 5-year horizon on real loan data.
    for (const point of returnRateDimension.points) {
      expect(Number.isFinite(point.projectedNetWorthIn5Years)).toBe(true);
      expect(Number.isFinite(point.netWorthDeltaIn5Years)).toBe(true);
    }
    // A higher assumed return rate should never produce a worse (lower) projection
    // than a lower one, all else equal.
    const sorted = [...returnRateDimension.points].sort((a, b) => a.paramValue - b.paramValue);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].projectedNetWorthIn5Years).toBeGreaterThanOrEqual(sorted[i - 1].projectedNetWorthIn5Years);
    }
  });

  it("the return-rate sweep still produces a finite result when the baseline has no loans at all", async () => {
    const baseRun = makeBaseRun(); // no `loans` field — legacy/no-loan baseline
    const mockSimulator = { run: jest.fn().mockResolvedValue(baseRun) };
    const service = new SensitivityAnalysisService(mockSimulator as never);

    const dimensions = await service.analyze("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 5000 }, baseRun);
    const returnRateDimension = dimensions.find((d) => d.field === "annualReturnPercent")!;

    expect(returnRateDimension.points.every((p) => Number.isFinite(p.projectedNetWorthIn5Years))).toBe(true);
  });
});
