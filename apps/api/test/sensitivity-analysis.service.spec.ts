import { SensitivityAnalysisService } from "../src/ai/scenario-studio/sensitivity/sensitivity-analysis.service";
import { SENSITIVITY_MULTIPLIERS, AGE_SENSITIVITY_DELTAS, RETURN_RATE_SENSITIVITY_PERCENTS } from "../src/ai/scenario-studio/scenario-studio.constants";

function makeBaseRun() {
  return {
    baseline: { monthlyIncome: 100000, monthlyExpenses: 60000, netWorth: 500000, investmentsValue: 300000, totalDebt: 200000, currentAge: 30, targetRetirementAge: 60 },
    result: {
      scenarioType: "SIP_INCREASE" as const,
      monthlyCashflowDelta: "0.00",
      netWorthDeltaIn5Years: "0.00",
      projectedNetWorthIn5Years: "500000.00",
      goalImpact: "",
      assumptions: [],
      narrative: "",
      isProjectionOnly: true as const,
    },
  };
}

describe("SensitivityAnalysisService.analyze", () => {
  it("sweeps the primary field at the configured multipliers for a magnitude-based scenario type", async () => {
    const mockSimulator = {
      run: jest.fn().mockResolvedValue({
        baseline: makeBaseRun().baseline,
        result: { ...makeBaseRun().result, projectedNetWorthIn5Years: "600000.00", netWorthDeltaIn5Years: "100000.00" },
      }),
    };
    const service = new SensitivityAnalysisService(mockSimulator as never);

    const dimensions = await service.analyze("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 10000 }, makeBaseRun());
    const primary = dimensions.find((d) => d.field === "additionalMonthlyAmount")!;

    expect(primary.points).toHaveLength(SENSITIVITY_MULTIPLIERS.length);
    expect(primary.points.map((p) => p.paramValue)).toEqual(SENSITIVITY_MULTIPLIERS.map((m) => 10000 * m));
  });

  it("sweeps age deltas (not multipliers) for RETIREMENT_AGE_SHIFT", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeBaseRun()) };
    const service = new SensitivityAnalysisService(mockSimulator as never);

    const dimensions = await service.analyze("user-1", "RETIREMENT_AGE_SHIFT", { newRetirementAge: 60 }, makeBaseRun());
    const primary = dimensions.find((d) => d.field === "newRetirementAge")!;

    expect(primary.points.map((p) => p.paramValue)).toEqual(AGE_SENSITIVITY_DELTAS.map((d) => 60 + d));
  });

  it("always includes a return-rate sensitivity dimension, independent of scenario type", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeBaseRun()) };
    const service = new SensitivityAnalysisService(mockSimulator as never);

    const dimensions = await service.analyze("user-1", "EMERGENCY_EXPENSE", { amount: 50000 }, makeBaseRun());
    const returnRate = dimensions.find((d) => d.field === "annualReturnPercent")!;

    expect(returnRate).toBeDefined();
    expect(returnRate.points).toHaveLength(RETURN_RATE_SENSITIVITY_PERCENTS.length);
    expect(returnRate.points.map((p) => p.paramValue)).toEqual([...RETURN_RATE_SENSITIVITY_PERCENTS]);
    // a higher assumed return rate should never produce a lower projected net worth
    for (let i = 1; i < returnRate.points.length; i++) {
      expect(returnRate.points[i].projectedNetWorthIn5Years).toBeGreaterThanOrEqual(returnRate.points[i - 1].projectedNetWorthIn5Years);
    }
  });

  it("computes the return-rate sweep directly (does not call SimulatorService.run for it)", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeBaseRun()) };
    const service = new SensitivityAnalysisService(mockSimulator as never);

    await service.analyze("user-1", "EMERGENCY_EXPENSE", { amount: 50000 }, makeBaseRun());

    // Only the primary-field sweep should call the simulator (5 multiplier points);
    // the return-rate sweep is computed directly via projectNetWorth.
    expect(mockSimulator.run).toHaveBeenCalledTimes(SENSITIVITY_MULTIPLIERS.length);
  });
});
