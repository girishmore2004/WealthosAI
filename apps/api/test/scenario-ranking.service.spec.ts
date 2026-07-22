import { ScenarioRankingService } from "../src/ai/scenario-studio/ranking/scenario-ranking.service";
import { ScenarioVariant } from "../src/ai/scenario-studio/expansion/scenario-expander.service";

function makeVariant(label: ScenarioVariant["label"], netWorthDelta: number, feasible: boolean, monthlyCashflowDelta = 0): ScenarioVariant {
  return {
    label,
    params: {},
    run: {
      baseline: { monthlyIncome: 0, monthlyExpenses: 0, netWorth: 0, investmentsValue: 0, totalDebt: 0, currentAge: 30, targetRetirementAge: 60 },
      result: {
        scenarioType: "SIP_INCREASE",
        monthlyCashflowDelta: monthlyCashflowDelta.toFixed(2),
        netWorthDeltaIn5Years: netWorthDelta.toFixed(2),
        projectedNetWorthIn5Years: "0.00",
        goalImpact: "",
        assumptions: [],
        narrative: "",
        isProjectionOnly: true,
      },
    },
    feasible,
    feasibilityNote: feasible ? "ok" : "not affordable",
  };
}

describe("ScenarioRankingService.rank", () => {
  it("ranks purely by netWorthDeltaIn5Years when all variants are feasible", async () => {
    const mockGoals = { list: jest.fn() };
    const service = new ScenarioRankingService(mockGoals as never);

    const variants = [makeVariant("worst", 10000, true), makeVariant("best", 50000, true), makeVariant("base", 30000, true)];
    const ranked = await service.rank("user-1", variants);

    expect(ranked.map((r) => r.label)).toEqual(["best", "base", "worst"]);
  });

  it("never lets an infeasible variant outrank a feasible one, regardless of its raw number", async () => {
    const mockGoals = { list: jest.fn() };
    const service = new ScenarioRankingService(mockGoals as never);

    // "best" has the highest raw net worth delta but is infeasible; "base" is feasible
    // with a much lower delta — base must still rank first.
    const variants = [makeVariant("best", 1000000, false), makeVariant("base", 5000, true), makeVariant("worst", -20000, true)];
    const ranked = await service.rank("user-1", variants);

    expect(ranked[0].label).toBe("base");
    expect(ranked.map((r) => r.label).indexOf("best")).toBeGreaterThan(ranked.map((r) => r.label).indexOf("base"));
  });

  it("does not fetch goals or compute goal impacts when no target goals are given", async () => {
    const mockGoals = { list: jest.fn() };
    const service = new ScenarioRankingService(mockGoals as never);

    const ranked = await service.rank("user-1", [makeVariant("base", 1000, true)]);

    expect(mockGoals.list).not.toHaveBeenCalled();
    expect(ranked[0].goalImpacts).toEqual([]);
  });

  it("includes a goal-impact note per target goal, reflecting the variant's monthly cashflow delta", async () => {
    const mockGoals = {
      list: jest.fn().mockResolvedValue([
        { id: "goal-1", name: "Emergency fund", requiredMonthlyContribution: 8000 },
        { id: "goal-2", name: "Vacation", requiredMonthlyContribution: 3000 },
      ]),
    };
    const service = new ScenarioRankingService(mockGoals as never);

    const ranked = await service.rank("user-1", [makeVariant("base", 20000, true, 5000)], ["goal-1"]);

    expect(ranked[0].goalImpacts).toHaveLength(1);
    expect(ranked[0].goalImpacts[0].goalId).toBe("goal-1");
    expect(ranked[0].goalImpacts[0].helped).toBe(true);
    expect(ranked[0].goalImpacts[0].note).toContain("Emergency fund");
  });

  it("marks a goal as not helped when the variant's cashflow delta is negative", async () => {
    const mockGoals = { list: jest.fn().mockResolvedValue([{ id: "goal-1", name: "House down payment", requiredMonthlyContribution: 15000 }]) };
    const service = new ScenarioRankingService(mockGoals as never);

    const ranked = await service.rank("user-1", [makeVariant("worst", -5000, true, -2000)], ["goal-1"]);

    expect(ranked[0].goalImpacts[0].helped).toBe(false);
  });
});
