import { ScenarioExplainerService } from "../src/ai/scenario-studio/explanation/scenario-explainer.service";
import { NumericConsistencyVerifier } from "../src/ai/coach/verification/numeric-consistency.verifier";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";
import { ScenarioVariant } from "../src/ai/scenario-studio/expansion/scenario-expander.service";
import { RankedVariant } from "../src/ai/scenario-studio/ranking/scenario-ranking.service";
import { MonteCarloResultDTO, OptimizedScenarioDTO } from "@wealthos/types";

function makeVariant(label: ScenarioVariant["label"]): ScenarioVariant {
  return {
    label,
    params: { additionalMonthlyAmount: 5000 },
    run: {
      baseline: { monthlyIncome: 0, monthlyExpenses: 0, netWorth: 0, investmentsValue: 0, totalDebt: 0, currentAge: 30, targetRetirementAge: 60 },
      result: { scenarioType: "SIP_INCREASE", monthlyCashflowDelta: "0.00", netWorthDeltaIn5Years: "12000.00", projectedNetWorthIn5Years: "0.00", goalImpact: "", assumptions: [], narrative: "", isProjectionOnly: true },
    },
    feasible: true,
    feasibilityNote: "ok",
  };
}

function makeRanked(label: ScenarioVariant["label"], score: number): RankedVariant {
  return { label, score, netWorthDeltaIn5Years: score, feasible: true, feasibilityNote: "ok", goalImpacts: [] };
}

describe("ScenarioExplainerService.explain", () => {
  const verifier = new NumericConsistencyVerifier();

  it("returns the composed explanation when it passes numeric verification", async () => {
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({ data: { explanation: "The 12000 net worth gain came from the higher SIP amount." }, confidence: 0.85 }),
    };
    const service = new ScenarioExplainerService(mockGateway as never, verifier);

    const variants = [makeVariant("best")];
    const ranked = [makeRanked("best", 12000)];
    const result = await service.explain("user-1", "SIP_INCREASE", variants, ranked);

    expect(result.verificationPassed).toBe(true);
    expect(result.text).toContain("12000");
  });

  it("falls back to the facts summary when the explanation introduces an unverifiable number", async () => {
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({ data: { explanation: "This variant yields a massive 999999 gain." }, confidence: 0.9 }),
    };
    const service = new ScenarioExplainerService(mockGateway as never, verifier);

    const variants = [makeVariant("best")];
    const ranked = [makeRanked("best", 12000)];
    const result = await service.explain("user-1", "SIP_INCREASE", variants, ranked);

    expect(result.verificationPassed).toBe(false);
    expect(result.text).not.toContain("999999");
    expect(result.confidence).toBe(0.5);
  });

  it("falls back to the facts summary when the gateway is unavailable", async () => {
    const mockGateway = { extract: jest.fn().mockRejectedValue(new AiUnavailableException("down")) };
    const service = new ScenarioExplainerService(mockGateway as never, verifier);

    const variants = [makeVariant("best")];
    const ranked = [makeRanked("best", 12000)];
    const result = await service.explain("user-1", "SIP_INCREASE", variants, ranked);

    expect(result.verificationPassed).toBe(false);
    expect(result.text).toContain("best");
  });
});

function makeMonteCarloResult(overrides: Partial<MonteCarloResultDTO> = {}): MonteCarloResultDTO {
  return {
    scenarioType: "SIP_INCREASE",
    iterations: 2000,
    horizonYears: 5,
    terminalPercentiles: { p10: 900000, p25: 950000, p50: 1000000, p75: 1050000, p90: 1100000 },
    probabilityOfNetWorthDecline: 0.12,
    probabilityOfGoalShortfall: null,
    riskLevel: "MEDIUM",
    coefficientOfVariation: 0.18,
    yearlyBands: [],
    assumptions: [],
    config: {
      iterations: 2000,
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

describe("ScenarioExplainerService.explainProbabilistic", () => {
  const verifier = new NumericConsistencyVerifier();

  it("returns the composed explanation when it passes numeric verification", async () => {
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({
        data: { explanation: "The median outcome is ₹1000000, with a range from ₹900000 to ₹1100000, a medium risk level." },
        confidence: 0.8,
      }),
    };
    const service = new ScenarioExplainerService(mockGateway as never, verifier);

    const result = await service.explainProbabilistic("user-1", "SIP_INCREASE", makeMonteCarloResult());

    expect(result.verificationPassed).toBe(true);
    expect(result.text).toContain("1000000");
  });

  it("falls back to the facts summary when the gateway is unavailable", async () => {
    const mockGateway = { extract: jest.fn().mockRejectedValue(new AiUnavailableException("down")) };
    const service = new ScenarioExplainerService(mockGateway as never, verifier);

    const result = await service.explainProbabilistic("user-1", "SIP_INCREASE", makeMonteCarloResult());

    expect(result.verificationPassed).toBe(false);
    expect(result.text).toContain("Median");
  });

  it("falls back to the facts summary when the explanation introduces an unverifiable number", async () => {
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({ data: { explanation: "You are guaranteed a massive ₹9999999 outcome." }, confidence: 0.9 }),
    };
    const service = new ScenarioExplainerService(mockGateway as never, verifier);

    const result = await service.explainProbabilistic("user-1", "SIP_INCREASE", makeMonteCarloResult());

    expect(result.verificationPassed).toBe(false);
    expect(result.text).not.toContain("9999999");
  });
});

describe("ScenarioExplainerService.explainOptimization", () => {
  const verifier = new NumericConsistencyVerifier();

  function makeOptimized(overrides: Partial<OptimizedScenarioDTO> = {}): OptimizedScenarioDTO {
    return {
      scenarioType: "SIP_INCREASE",
      recommendedParams: { additionalMonthlyAmount: 15000 },
      searchRange: { min: 0, max: 32000 },
      candidatesEvaluated: 16,
      monteCarlo: makeMonteCarloResult(),
      feasible: true,
      violatedConstraints: [],
      riskAdjustedScore: 950000,
      constraintsApplied: { scenarioType: "SIP_INCREASE" },
      ...overrides,
    };
  }

  it("returns the composed explanation when it passes numeric verification", async () => {
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({
        data: { explanation: "₹15000/month was recommended, balancing a median of ₹1000000 against the downside risk to ₹900000." },
        confidence: 0.82,
      }),
    };
    const service = new ScenarioExplainerService(mockGateway as never, verifier);

    const result = await service.explainOptimization("user-1", makeOptimized());

    expect(result.verificationPassed).toBe(true);
    expect(result.text).toContain("15000");
  });

  it("falls back to the facts summary when the gateway is unavailable", async () => {
    const mockGateway = { extract: jest.fn().mockRejectedValue(new AiUnavailableException("down")) };
    const service = new ScenarioExplainerService(mockGateway as never, verifier);

    const result = await service.explainOptimization("user-1", makeOptimized());

    expect(result.verificationPassed).toBe(false);
    expect(result.text).toContain("Recommended");
  });
});
