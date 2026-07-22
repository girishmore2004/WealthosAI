import { ScenarioExplainerService } from "../src/ai/scenario-studio/explanation/scenario-explainer.service";
import { NumericConsistencyVerifier } from "../src/ai/coach/verification/numeric-consistency.verifier";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";
import { ScenarioVariant } from "../src/ai/scenario-studio/expansion/scenario-expander.service";
import { RankedVariant } from "../src/ai/scenario-studio/ranking/scenario-ranking.service";

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
