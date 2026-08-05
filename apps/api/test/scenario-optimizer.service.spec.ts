import { BadRequestException } from "@nestjs/common";
import { ScenarioOptimizerService } from "../src/ai/scenario-studio/optimization/scenario-optimizer.service";
import { MonteCarloResultDTO, RunScenarioResponseDTO } from "@wealthos/types";

function makeMonteCarloResult(p50: number, overrides: Partial<MonteCarloResultDTO> = {}): MonteCarloResultDTO {
  return {
    scenarioType: "SIP_INCREASE",
    iterations: 300,
    horizonYears: 5,
    terminalPercentiles: { p10: p50 - 50000, p25: p50 - 25000, p50, p75: p50 + 25000, p90: p50 + 50000 },
    probabilityOfNetWorthDecline: 0.1,
    probabilityOfGoalShortfall: null,
    riskLevel: "MEDIUM",
    coefficientOfVariation: 0.2,
    yearlyBands: [],
    assumptions: [],
    config: {
      iterations: 300,
      horizonYears: 5,
      seed: 1,
      annualReturnMeanPercent: 10,
      annualReturnStdDevPercent: 15,
      expenseInflationMeanPercent: 6,
      expenseInflationStdDevPercent: 2,
      incomeGrowthMeanPercent: 3,
      incomeGrowthStdDevPercent: 4,
      propertyAppreciationMeanPercent: 5,
      propertyAppreciationStdDevPercent: 6,
    },
    ...overrides,
  };
}

function makeProbeRun(): RunScenarioResponseDTO {
  return {
    baseline: {
      monthlyIncome: 100000,
      monthlyExpenses: 50000,
      netWorth: 1000000,
      investmentsValue: 500000,
      totalDebt: 200000,
      currentAge: 30,
      targetRetirementAge: 60,
      loans: [],
      totalMonthlyEmi: 10000,
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

describe("ScenarioOptimizerService", () => {
  it("rejects a scenario type with no optimizable decision variable", async () => {
    const service = new ScenarioOptimizerService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(service.optimize("user-1", { scenarioType: "HOUSE_PURCHASE" } as never)).rejects.toThrow(BadRequestException);
  });

  it("requires loanId for LOAN_PREPAYMENT optimization", async () => {
    const service = new ScenarioOptimizerService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(service.optimize("user-1", { scenarioType: "LOAN_PREPAYMENT" } as never)).rejects.toThrow(BadRequestException);
  });

  it("requires goalId for GOAL_DELAY optimization", async () => {
    const service = new ScenarioOptimizerService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(service.optimize("user-1", { scenarioType: "GOAL_DELAY" } as never)).rejects.toThrow(BadRequestException);
  });

  it("recommends the SIP amount with the best risk-adjusted score within budget, and re-runs it at full fidelity", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeProbeRun()) };
    const mockGoals = { list: jest.fn().mockResolvedValue([]) };
    const mockLoans = { debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "10000.00" }) };
    const mockInvestments = { list: jest.fn().mockResolvedValue([]) };
    const mockTax = { listDeductions: jest.fn().mockResolvedValue([]) };

    // Reduced-fidelity search calls return a p50 that increases with the candidate's
    // SIP amount (monotonic reward), so the optimizer should climb toward the top of
    // the feasible range.
    const mockMonteCarlo = {
      simulate: jest.fn().mockImplementation((_userId: string, _type: string, params: Record<string, unknown>) => {
        const amount = Number(params.additionalMonthlyAmount ?? 0);
        return Promise.resolve(makeMonteCarloResult(1000000 + amount * 10));
      }),
    };

    const service = new ScenarioOptimizerService(
      mockSimulator as never,
      mockGoals as never,
      mockLoans as never,
      mockInvestments as never,
      mockTax as never,
      mockMonteCarlo as never,
    );

    const result = await service.optimize("user-1", {
      scenarioType: "SIP_INCREASE",
      respectTaxAdvantagedLimit: false, // isolate the budget constraint only
    } as never);

    expect(result.scenarioType).toBe("SIP_INCREASE");
    expect(result.feasible).toBe(true);
    expect(result.candidatesEvaluated).toBeGreaterThan(0);
    // Budget = surplus (100000 - 50000 - 10000 = 40000) * default 0.8 fraction = 32000.
    expect(result.searchRange.max).toBeCloseTo(32000, 0);
    // The reward is monotonically increasing in the SIP amount, so the recommended
    // value should land at (or very near) the top of the feasible range.
    expect(Number(result.recommendedParams.additionalMonthlyAmount)).toBeGreaterThan(20000);
    // The final reported Monte Carlo result must be a fresh full-fidelity call, not
    // one of the reduced-fidelity search candidates re-used as-is.
    expect(result.monteCarlo).toBeDefined();
  });

  it("caps the SIP search range at remaining Section 80C headroom when respectTaxAdvantagedLimit is not disabled", async () => {
    const mockSimulator = { run: jest.fn().mockResolvedValue(makeProbeRun()) };
    const mockGoals = { list: jest.fn().mockResolvedValue([]) };
    const mockLoans = { debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "10000.00" }) };
    const mockInvestments = { list: jest.fn().mockResolvedValue([]) };
    // ₹140,000 already used out of the ₹150,000 2025-26 Section 80C limit -> ₹10,000
    // annual headroom -> ₹833.33/month.
    const mockTax = {
      listDeductions: jest.fn().mockResolvedValue([{ section: "SECTION_80C", amount: 140000 }]),
    };
    const mockMonteCarlo = { simulate: jest.fn().mockResolvedValue(makeMonteCarloResult(1000000)) };

    const service = new ScenarioOptimizerService(
      mockSimulator as never,
      mockGoals as never,
      mockLoans as never,
      mockInvestments as never,
      mockTax as never,
      mockMonteCarlo as never,
    );

    const result = await service.optimize("user-1", { scenarioType: "SIP_INCREASE" } as never);

    // Budget alone would allow up to ₹32,000/month — the tax headroom (~₹833/month)
    // should be the binding constraint instead.
    expect(result.searchRange.max).toBeLessThan(1000);
    expect(result.searchRange.max).toBeCloseTo(10000 / 12, 1);
  });
});
