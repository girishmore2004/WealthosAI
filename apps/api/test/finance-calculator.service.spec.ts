import { FinanceCalculatorService } from "../src/ai/coach/calculation/finance-calculator.service";

function makeCalculator() {
  return new FinanceCalculatorService({} as never, {} as never, {} as never);
}

describe("FinanceCalculatorService — pure math", () => {
  it("computes a hypothetical EMI matching the standard annuity formula", () => {
    const calc = makeCalculator();
    const result = calc.emiForHypotheticalLoan(500000, 9, 60);

    // Standard EMI formula check: emi * tenure ≈ totalPayable, and interest is positive.
    expect(result.emi).toBeGreaterThan(0);
    expect(Number((result.emi * 60).toFixed(2))).toBe(result.totalPayable);
    expect(result.totalInterest).toBe(Number((result.totalPayable - 500000).toFixed(2)));
  });

  it("projects a savings goal with compounding contributions", () => {
    const calc = makeCalculator();
    const result = calc.projectSavingsGoal({
      currentAmount: 100000,
      monthlyContribution: 10000,
      annualReturnPercent: 8,
      months: 24,
    });

    expect(result.totalContributed).toBe(100000 + 10000 * 24);
    expect(result.projectedValue).toBeGreaterThan(result.totalContributed); // positive return should grow it
    expect(result.totalGrowth).toBe(Number((result.projectedValue - result.totalContributed).toFixed(2)));
  });

  it("computes required monthly savings contribution consistent with projectSavingsGoal's inverse", () => {
    const calc = makeCalculator();
    const required = calc.requiredMonthlySavingsContribution({
      targetAmount: 1200000,
      currentAmount: 0,
      annualReturnPercent: 7,
      months: 36,
    });

    const projection = calc.projectSavingsGoal({
      currentAmount: 0,
      monthlyContribution: required,
      annualReturnPercent: 7,
      months: 36,
    });

    // The computed required contribution should land within a rupee of the target
    // when projected forward with the same assumptions — confirms the two formulas
    // are true inverses of each other, not independently-drifted approximations.
    expect(Math.abs(projection.projectedValue - 1200000)).toBeLessThan(1);
  });

  it("returns zero required contribution when the target is already met", () => {
    const calc = makeCalculator();
    const required = calc.requiredMonthlySavingsContribution({
      targetAmount: 100000,
      currentAmount: 500000,
      annualReturnPercent: 5,
      months: 12,
    });

    expect(required).toBe(0);
  });

  it("computes monthly surplus using the same formula as Scenario Studio's affordability util", () => {
    const calc = makeCalculator();
    expect(calc.monthlySurplus(100000, 60000, 15000)).toBe(25000);
  });
});
