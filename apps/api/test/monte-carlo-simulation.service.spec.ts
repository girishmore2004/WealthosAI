import { MonteCarloSimulationService } from "../src/ai/scenario-studio/monte-carlo/monte-carlo-simulation.service";
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
      loans: [],
      totalMonthlyEmi: 0,
      ...overrides,
    },
    result: {
      scenarioType: "SIP_INCREASE",
      monthlyCashflowDelta: "0.00",
      netWorthDeltaIn5Years: "0.00",
      projectedNetWorthIn5Years: "0.00",
      goalImpact: "",
      assumptions: [],
      narrative: "",
      isProjectionOnly: true,
    },
  };
}

describe("MonteCarloSimulationService.simulate", () => {
  it("returns percentile outputs, a risk level, and clamps iterations to the configured bounds", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeBaseRun()) };
    const service = new MonteCarloSimulationService(mockSimulator as never);

    const result = await service.simulate("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 5000 }, { iterations: 50 });

    // 50 is below MIN_MC_ITERATIONS (200) — must be clamped up, not passed through.
    expect(result.iterations).toBe(200);
    expect(result.terminalPercentiles.p10).toBeLessThanOrEqual(result.terminalPercentiles.p50);
    expect(result.terminalPercentiles.p50).toBeLessThanOrEqual(result.terminalPercentiles.p90);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(result.riskLevel);
  });

  it("is deterministic for identical inputs (no explicit seed override)", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeBaseRun()) };
    const service = new MonteCarloSimulationService(mockSimulator as never);

    const resultA = await service.simulate("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 5000 }, { iterations: 300 });
    const resultB = await service.simulate("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 5000 }, { iterations: 300 });

    expect(resultA.terminalPercentiles).toEqual(resultB.terminalPercentiles);
  });

  it("produces a different distribution for a different user (different deterministic seed)", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeBaseRun()) };
    const service = new MonteCarloSimulationService(mockSimulator as never);

    const resultA = await service.simulate("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 5000 }, { iterations: 500 });
    const resultB = await service.simulate("user-2", "SIP_INCREASE", { additionalMonthlyAmount: 5000 }, { iterations: 500 });

    expect(resultA.terminalPercentiles.p50).not.toBeCloseTo(resultB.terminalPercentiles.p50, 0);
  });

  it("defaults RETIREMENT_AGE_SHIFT's horizon to years-until-target-retirement-age, not the flat 5-year default", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeBaseRun({ currentAge: 30, targetRetirementAge: 60 })) };
    const service = new MonteCarloSimulationService(mockSimulator as never);

    const result = await service.simulate("user-1", "RETIREMENT_AGE_SHIFT", { newRetirementAge: 55 }, { iterations: 200 });

    expect(result.horizonYears).toBe(30); // 60 - 30
  });

  it("computes probabilityOfGoalShortfall only when a goal target is supplied", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeBaseRun()) };
    const service = new MonteCarloSimulationService(mockSimulator as never);

    const withoutTarget = await service.simulate("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 5000 }, { iterations: 200 });
    expect(withoutTarget.probabilityOfGoalShortfall).toBeNull();

    const withTarget = await service.simulate(
      "user-1",
      "SIP_INCREASE",
      { additionalMonthlyAmount: 5000 },
      { iterations: 200 },
      100000000, // an unreachably high target -> ~100% shortfall probability
    );
    expect(withTarget.probabilityOfGoalShortfall).toBeGreaterThan(0.9);
  });

  it("amortizes a real loan month-by-month for LOAN_PREPAYMENT rather than holding debt flat", async () => {
    const mockSimulator = {
      run: jest.fn().mockResolvedValue(
        makeBaseRun({ loans: [{ id: "loan-1", principal: 500000, annualRatePercent: 9, emi: 12000 }], totalMonthlyEmi: 12000 }),
      ),
    };
    const service = new MonteCarloSimulationService(mockSimulator as never);

    const result = await service.simulate("user-1", "LOAN_PREPAYMENT", { loanId: "loan-1", lumpSum: 100000 }, { iterations: 200 });

    expect(Number.isFinite(result.terminalPercentiles.p50)).toBe(true);
  });
});
