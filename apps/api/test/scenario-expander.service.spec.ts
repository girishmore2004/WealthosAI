import { ScenarioExpanderService } from "../src/ai/scenario-studio/expansion/scenario-expander.service";

function makeRunResponse(overrides: Partial<{ monthlyIncome: number; monthlyExpenses: number; investmentsValue: number; totalDebt: number; netWorth: number; currentAge: number | null; targetRetirementAge: number }> = {}) {
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
      isProjectionOnly: true as const,
    },
  };
}

describe("ScenarioExpanderService.expand", () => {
  it("generates best/base/worst/constrained variants with direction-aware multipliers for an optimistic field", async () => {
    const baseRun = makeRunResponse();
    const mockSimulator = { run: jest.fn().mockResolvedValue(baseRun) };
    const mockLoans = { debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "5000" }) };
    const expander = new ScenarioExpanderService(mockSimulator as never, mockLoans as never);

    const variants = await expander.expand("user-1", "SALARY_HIKE", { percentIncrease: 10 });

    expect(variants.map((v) => v.label)).toEqual(["best", "base", "worst", "constrained"]);
    const best = variants.find((v) => v.label === "best")!;
    const worst = variants.find((v) => v.label === "worst")!;
    // percentIncrease is "optimistic" — best case should use the larger multiplier (1.5x = 15), worst the smaller (0.5x = 5)
    expect(best.params.percentIncrease).toBe(15);
    expect(worst.params.percentIncrease).toBe(5);
  });

  it("caps the constrained SIP_INCREASE variant at the available monthly surplus", async () => {
    const baseRun = makeRunResponse({ monthlyIncome: 100000, monthlyExpenses: 90000 }); // surplus before EMI: 10000
    const mockSimulator = { run: jest.fn().mockResolvedValue(baseRun) };
    const mockLoans = { debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "5000" }) }; // surplus = 100000-90000-5000 = 5000
    const expander = new ScenarioExpanderService(mockSimulator as never, mockLoans as never);

    // best-case would be 20000 * 1.5 = 30000, far above the 5000 surplus
    const variants = await expander.expand("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 20000 });
    const constrained = variants.find((v) => v.label === "constrained")!;

    expect(constrained.params.additionalMonthlyAmount).toBe(5000);
    expect(constrained.feasible).toBe(true);
  });

  it("marks a SIP_INCREASE variant infeasible when it exceeds the available surplus", async () => {
    const baseRun = makeRunResponse({ monthlyIncome: 100000, monthlyExpenses: 95000 });
    const mockSimulator = { run: jest.fn().mockResolvedValue(baseRun) };
    const mockLoans = { debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "4000" }) }; // surplus = 1000
    const expander = new ScenarioExpanderService(mockSimulator as never, mockLoans as never);

    const variants = await expander.expand("user-1", "SIP_INCREASE", { additionalMonthlyAmount: 5000 });
    const best = variants.find((v) => v.label === "best")!; // 5000*1.5=7500, way above surplus of 1000

    expect(best.feasible).toBe(false);
    expect(best.feasibilityNote).toMatch(/exceeds/i);
  });

  it("uses the base value for constrained when the field is not a discretionary spend", async () => {
    const baseRun = makeRunResponse();
    const mockSimulator = { run: jest.fn().mockResolvedValue(baseRun) };
    const mockLoans = { debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "0" }) };
    const expander = new ScenarioExpanderService(mockSimulator as never, mockLoans as never);

    const variants = await expander.expand("user-1", "EMERGENCY_EXPENSE", { amount: 50000 });
    const constrained = variants.find((v) => v.label === "constrained")!;
    const base = variants.find((v) => v.label === "base")!;

    expect(constrained.params.amount).toBe(base.params.amount);
  });

  it("handles RETIREMENT_AGE_SHIFT's age field with the special-cased (non-multiplied) variant logic", async () => {
    const baseRun = makeRunResponse({ currentAge: 30, targetRetirementAge: 60 });
    const mockSimulator = { run: jest.fn().mockResolvedValue(baseRun) };
    const mockLoans = { debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "0" }) };
    const expander = new ScenarioExpanderService(mockSimulator as never, mockLoans as never);

    const variants = await expander.expand("user-1", "RETIREMENT_AGE_SHIFT", { newRetirementAge: 55 });
    const best = variants.find((v) => v.label === "best")!;
    const worst = variants.find((v) => v.label === "worst")!;

    // Ages, not multiplied — best should be a later age than the anchor (60), worst earlier, and never below currentAge+1
    expect(Number(best.params.newRetirementAge)).toBeGreaterThan(60);
    expect(Number(worst.params.newRetirementAge)).toBeGreaterThanOrEqual(31);
  });
});
