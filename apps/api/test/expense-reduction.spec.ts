import { runScenario, projectNetWorth } from "../src/simulator/simulator.engine";
import { ScenarioBaselineDTO } from "@wealthos/types";

const baseline: ScenarioBaselineDTO = {
  monthlyIncome: 100000,
  monthlyExpenses: 60000,
  netWorth: 500000,
  investmentsValue: 300000,
  totalDebt: 200000,
  currentAge: 30,
  targetRetirementAge: 60,
};

const baselineWithLoan: ScenarioBaselineDTO = {
  ...baseline,
  loans: [{ id: "loan-1", principal: 200000, annualRatePercent: 8.5, emi: 4500 }],
  totalMonthlyEmi: 4500,
};

describe("EXPENSE_REDUCTION scenario (deterministic engine)", () => {
  it("20% of ₹60,000 expenses frees exactly ₹12,000/month", () => {
    const result = runScenario("EXPENSE_REDUCTION", { percentDecrease: 20 }, baseline);
    expect(result.scenarioType).toBe("EXPENSE_REDUCTION");
    expect(result.monthlyCashflowDelta).toBe("12000.00");
    expect(result.isProjectionOnly).toBe(true);
  });

  it("closed-form path: 5-year delta equals 12,000 × 60 months of idle cash", () => {
    const result = runScenario("EXPENSE_REDUCTION", { percentDecrease: 20 }, baseline);
    expect(Number(result.netWorthDeltaIn5Years)).toBeCloseTo(12000 * 60, 2);
  });

  it("with loan detail, the saving is inflated identically on both sides (delta > flat 12,000 × 60)", () => {
    const result = runScenario("EXPENSE_REDUCTION", { percentDecrease: 20 }, baselineWithLoan);
    const flat = 12000 * 60;
    // Expenses inflate at 6%/yr, so the avoided spend is larger than the flat figure.
    expect(Number(result.netWorthDeltaIn5Years)).toBeGreaterThan(flat);
    expect(Number(result.netWorthDeltaIn5Years)).toBeLessThan(flat * 1.2);
  });

  it("matches a direct projectNetWorth difference (no hidden adjustments)", () => {
    const common = { monthlyIncome: 100000, monthlyInvestmentContribution: 0, investmentsValue: 300000, debt: 0, months: 60 };
    const base = projectNetWorth({ ...common, monthlyExpenses: 60000 });
    const reduced = projectNetWorth({ ...common, monthlyExpenses: 48000 });
    const result = runScenario("EXPENSE_REDUCTION", { percentDecrease: 20 }, baseline);
    expect(Number(result.netWorthDeltaIn5Years)).toBeCloseTo(reduced - base, 2);
  });

  it("0% reduction is a no-op", () => {
    const result = runScenario("EXPENSE_REDUCTION", { percentDecrease: 0 }, baseline);
    expect(result.monthlyCashflowDelta).toBe("0.00");
    expect(result.netWorthDeltaIn5Years).toBe("0.00");
  });

  it("clamps a >100% reduction at zero expenses and says so", () => {
    const result = runScenario("EXPENSE_REDUCTION", { percentDecrease: 150 }, baseline);
    expect(result.monthlyCashflowDelta).toBe("60000.00");
    expect(result.assumptions.some((a) => a.includes("treated as 100%"))).toBe(true);
  });

  it("is distinct from SALARY_DROP: opposite sign of cash-flow effect", () => {
    const cut = runScenario("EXPENSE_REDUCTION", { percentDecrease: 20 }, baseline);
    const drop = runScenario("SALARY_DROP", { percentDecrease: 20 }, baseline);
    expect(Number(cut.monthlyCashflowDelta)).toBeGreaterThan(0);
    expect(Number(drop.monthlyCashflowDelta)).toBeLessThan(0);
  });

  it("states that the saving is not auto-invested", () => {
    const result = runScenario("EXPENSE_REDUCTION", { percentDecrease: 20 }, baseline);
    expect(result.assumptions.some((a) => a.includes("not to be invested"))).toBe(true);
  });
});
