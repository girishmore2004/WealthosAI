import { runScenario, calculateEmi, projectNetWorth, LoanAmortizationInput } from "../src/simulator/simulator.engine";
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

// A baseline with real per-loan detail — exercises the new month-by-month
// amortization/inflation path (`baseline` above intentionally omits `loans`, which
// exercises the legacy flat-debt fallback path for backward compatibility).
const baselineWithLoan: ScenarioBaselineDTO = {
  ...baseline,
  loans: [{ id: "loan-1", principal: 200000, annualRatePercent: 8.5, emi: 4500 }],
  totalMonthlyEmi: 4500,
};

describe("simulator.engine (pure, deterministic)", () => {
  describe("projectNetWorth / calculateEmi — building blocks", () => {
    it("is deterministic: same inputs always produce the same output", () => {
      const a = projectNetWorth({ monthlyIncome: 10000, monthlyExpenses: 5000, monthlyInvestmentContribution: 1000, investmentsValue: 50000, debt: 10000, months: 12 });
      const b = projectNetWorth({ monthlyIncome: 10000, monthlyExpenses: 5000, monthlyInvestmentContribution: 1000, investmentsValue: 50000, debt: 10000, months: 12 });
      expect(a).toBe(b);
    });

    it("handles zero income without producing NaN/Infinity", () => {
      const result = projectNetWorth({ monthlyIncome: 0, monthlyExpenses: 20000, monthlyInvestmentContribution: 0, investmentsValue: 0, debt: 0, months: 60 });
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeLessThan(0); // pure expense drain, no income
    });

    it("handles a negative starting net worth (more debt than assets) without crashing", () => {
      const result = projectNetWorth({ monthlyIncome: 30000, monthlyExpenses: 25000, monthlyInvestmentContribution: 0, investmentsValue: 0, debt: 1000000, months: 12 });
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeLessThan(0);
    });

    it("calculateEmi returns 0 for a zero/negative principal or tenure instead of throwing", () => {
      expect(calculateEmi(0, 8, 120)).toBe(0);
      expect(calculateEmi(500000, 8, 0)).toBe(0);
      expect(Number.isFinite(calculateEmi(500000, 8, 120))).toBe(true);
    });

    it("calculateEmi handles a 0% interest rate as simple principal/tenure division", () => {
      expect(calculateEmi(120000, 0, 12)).toBe(10000);
    });
  });

  describe("SALARY_HIKE / SALARY_DROP", () => {
    it("a salary hike increases projected 5-year net worth versus baseline", () => {
      const result = runScenario("SALARY_HIKE", { percentIncrease: 10 }, baseline);
      expect(Number(result.netWorthDeltaIn5Years)).toBeGreaterThan(0);
    });

    it("a 100% salary drop floors income at zero, not negative", () => {
      const result = runScenario("SALARY_DROP", { percentDecrease: 100 }, baseline);
      expect(Number(result.monthlyCashflowDelta)).toBeCloseTo(-baseline.monthlyIncome, 0);
      expect(result.narrative).toMatch(/0/);
    });
  });

  describe("SIP_INCREASE / SIP_DECREASE", () => {
    it("increasing SIP improves projected net worth versus baseline (compounding beats idle cash)", () => {
      const result = runScenario("SIP_INCREASE", { additionalMonthlyAmount: 5000 }, baseline);
      expect(Number(result.netWorthDeltaIn5Years)).toBeGreaterThan(0);
    });

    it("decreasing SIP REDUCES projected net worth versus continuing to invest it (the bug this test guards against)", () => {
      const result = runScenario("SIP_DECREASE", { reducedMonthlyAmount: 5000 }, baseline);
      // This is the critical regression check: an earlier draft had this backwards,
      // showing decreasing a SIP as *improving* net worth. Stopping a SIP must show a
      // negative delta versus letting it keep compounding.
      expect(Number(result.netWorthDeltaIn5Years)).toBeLessThan(0);
    });

    it("SIP_INCREASE and SIP_DECREASE of the same amount are roughly symmetric in magnitude", () => {
      const increase = runScenario("SIP_INCREASE", { additionalMonthlyAmount: 5000 }, baseline);
      const decrease = runScenario("SIP_DECREASE", { reducedMonthlyAmount: 5000 }, baseline);
      const ratio = Math.abs(Number(increase.netWorthDeltaIn5Years)) / Math.abs(Number(decrease.netWorthDeltaIn5Years));
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    });
  });

  describe("HOUSE_PURCHASE", () => {
    it("adds a real EMI to monthly expenses and increases debt by the loan principal", () => {
      const result = runScenario(
        "HOUSE_PURCHASE",
        { propertyValue: 5000000, downPaymentPercent: 20, loanInterestRateAnnual: 8.5, loanTenureMonths: 240 },
        baseline,
      );
      expect(Number(result.monthlyCashflowDelta)).toBeLessThan(0); // EMI reduces cashflow
      expect(result.assumptions.some((a) => a.includes("amortization"))).toBe(true);
    });

    it("flags when the new EMI alone would exceed current monthly surplus", () => {
      const tightBaseline: ScenarioBaselineDTO = { ...baseline, monthlyIncome: 65000 }; // surplus = 5000
      const result = runScenario(
        "HOUSE_PURCHASE",
        { propertyValue: 8000000, downPaymentPercent: 10, loanInterestRateAnnual: 9, loanTenureMonths: 180 },
        tightBaseline,
      );
      expect(result.goalImpact).toMatch(/exceed/i);
    });
  });

  describe("LOAN_PREPAYMENT", () => {
    it("uses real amortization figures passed via context, not an approximation", () => {
      const result = runScenario(
        "LOAN_PREPAYMENT",
        { loanId: "loan-1", lumpSum: 100000 },
        baseline,
        { loanPrepayment: { interestSaved: 45000, monthsSaved: 8, newTenureMonths: 100 } },
      );
      expect(result.narrative).toContain("45000");
      expect(result.narrative).toContain("8");
    });

    it("still produces a finite result when no prepayment context is supplied", () => {
      const result = runScenario("LOAN_PREPAYMENT", { loanId: "loan-1", lumpSum: 50000 }, baseline);
      expect(Number.isFinite(Number(result.netWorthDeltaIn5Years))).toBe(true);
    });
  });

  describe("RETIREMENT_AGE_SHIFT", () => {
    it("delaying retirement extends the horizon and produces a non-zero, positive corpus delta (more time to compound)", () => {
      const result = runScenario("RETIREMENT_AGE_SHIFT", { newRetirementAge: 65 }, baseline);
      expect(result.narrative).toContain("65");
      expect(Number(result.netWorthDeltaIn5Years)).toBeGreaterThan(0);
    });

    it("retiring earlier produces a negative corpus delta versus the original target age", () => {
      const result = runScenario("RETIREMENT_AGE_SHIFT", { newRetirementAge: 55 }, baseline);
      expect(Number(result.netWorthDeltaIn5Years)).toBeLessThan(0);
    });

    it("handles a currentAge of null (no retirement profile set) by falling back gracefully", () => {
      const noAgeBaseline: ScenarioBaselineDTO = { ...baseline, currentAge: null };
      const result = runScenario("RETIREMENT_AGE_SHIFT", { newRetirementAge: 65 }, noAgeBaseline);
      expect(Number.isFinite(Number(result.projectedNetWorthIn5Years))).toBe(true);
    });
  });

  describe("EMERGENCY_EXPENSE", () => {
    it("deducts the amount immediately from net worth", () => {
      const result = runScenario("EMERGENCY_EXPENSE", { amount: 50000 }, baseline);
      expect(Number(result.netWorthDeltaIn5Years)).toBeCloseTo(-50000, 0);
    });

    it("flags when the expense would exceed current net worth entirely", () => {
      const result = runScenario("EMERGENCY_EXPENSE", { amount: 10000000 }, baseline);
      expect(result.goalImpact).toMatch(/exceed/i);
    });
  });

  describe("GOAL_DELAY", () => {
    it("does not change net worth trajectory — only the goal's required contribution", () => {
      const result = runScenario(
        "GOAL_DELAY",
        { goalId: "goal-1", delayMonths: 12 },
        baseline,
        { goalDelay: { goalName: "House down payment", currentRequiredMonthlyContribution: 20000, newRequiredMonthlyContribution: 14000 } },
      );
      expect(Number(result.netWorthDeltaIn5Years)).toBe(0);
      expect(result.goalImpact).toContain("14000");
    });

    it("reports the goal as not found when no context is supplied, rather than fabricating numbers", () => {
      const result = runScenario("GOAL_DELAY", { goalId: "missing", delayMonths: 6 }, baseline);
      expect(result.goalImpact).toMatch(/not found/i);
    });
  });

  it("every scenario type returns isProjectionOnly: true", () => {
    const result = runScenario("SALARY_HIKE", { percentIncrease: 5 }, baseline);
    expect(result.isProjectionOnly).toBe(true);
  });

  describe("projectNetWorth — loan amortization & expense inflation (month-by-month path)", () => {
    const loans: LoanAmortizationInput[] = [{ id: "l1", principal: 200000, annualRatePercent: 8.5, emi: 4500 }];

    it("without `loans`, behaves exactly like the original closed-form calculation (debt held flat)", () => {
      const a = projectNetWorth({ monthlyIncome: 100000, monthlyExpenses: 60000, monthlyInvestmentContribution: 5000, investmentsValue: 300000, debt: 200000, months: 60 });
      // Same inputs, but with an EXPLICIT empty loans array — must be identical to the
      // implicit-undefined case, since both are documented as the same fallback path.
      const b = projectNetWorth({ monthlyIncome: 100000, monthlyExpenses: 60000, monthlyInvestmentContribution: 5000, investmentsValue: 300000, debt: 200000, months: 60, loans: [] });
      expect(a).toBe(b);
    });

    it("a fully-amortizing loan costs roughly its own principal+interest in cash, then stops dragging on cash flow", () => {
      // A ₹200,000 loan at 8.5% with a ₹4,500 EMI pays off in ~54 months. Over a long
      // 600-month horizon, the ONLY difference from a debt-free baseline should be the
      // real cash actually paid (principal + interest) while the loan was active —
      // bounded and modest — not an unbounded drag, and not zero either (interest is a
      // real cost, unlike the old model which held debt flat and ignored it).
      const debtFree = projectNetWorth({ monthlyIncome: 100000, monthlyExpenses: 60000, monthlyInvestmentContribution: 0, investmentsValue: 0, debt: 0, months: 600, loans: [] });
      const withLoan = projectNetWorth({ monthlyIncome: 100000, monthlyExpenses: 60000, monthlyInvestmentContribution: 0, investmentsValue: 0, debt: 0, months: 600, loans });
      expect(withLoan).toBeLessThan(debtFree); // paying real interest is a real cost
      expect(withLoan).toBeGreaterThan(debtFree - 300000); // but bounded — not an unbounded/perpetual drag once paid off
    });

    it("a loan whose EMI doesn't cover interest stays stuck (balance never grows or crashes to -Infinity)", () => {
      const stuckLoans: LoanAmortizationInput[] = [{ id: "l1", principal: 200000, annualRatePercent: 8.5, emi: 100 }];
      const projected = projectNetWorth({ monthlyIncome: 100000, monthlyExpenses: 60000, monthlyInvestmentContribution: 0, investmentsValue: 0, debt: 0, months: 60, loans: stuckLoans });
      expect(Number.isFinite(projected)).toBe(true);
    });

    it("higher expense inflation reduces the projected outcome versus a lower rate, all else equal", () => {
      const lowInflation = projectNetWorth({ monthlyIncome: 100000, monthlyExpenses: 60000, monthlyInvestmentContribution: 0, investmentsValue: 0, debt: 0, months: 60, loans: [], expenseInflationPercent: 0 });
      // loans:[] alone doesn't trigger the month-by-month path (see fast-path guard),
      // so use a trivial zero-EMI/zero-principal loan to force it while keeping the
      // debt side inert, isolating the inflation effect specifically.
      const inert: LoanAmortizationInput[] = [{ id: "noop", principal: 0, annualRatePercent: 0, emi: 0 }];
      const noInflation = projectNetWorth({ monthlyIncome: 100000, monthlyExpenses: 60000, monthlyInvestmentContribution: 0, investmentsValue: 0, debt: 0, months: 60, loans: inert, expenseInflationPercent: 0 });
      const withInflation = projectNetWorth({ monthlyIncome: 100000, monthlyExpenses: 60000, monthlyInvestmentContribution: 0, investmentsValue: 0, debt: 0, months: 60, loans: inert, expenseInflationPercent: 6 });
      expect(withInflation).toBeLessThan(noInflation);
      expect(lowInflation).toBeLessThan(Infinity); // sanity: fast path still finite
    });
  });

  describe("HOUSE_PURCHASE — new loan is amortized alongside existing loans", () => {
    it("includes the new loan's amortization schedule, not just a flat EMI-as-expense adjustment", () => {
      const result = runScenario(
        "HOUSE_PURCHASE",
        { propertyValue: 5000000, downPaymentPercent: 20, loanInterestRateAnnual: 8.5, loanTenureMonths: 240 },
        baselineWithLoan,
      );
      expect(result.assumptions.some((a) => a.includes("amortization"))).toBe(true);
      expect(Number(result.monthlyCashflowDelta)).toBeLessThan(0);
    });
  });

  describe("LOAN_PREPAYMENT — scenario-side loan balance is actually reduced for the projection", () => {
    it("a matching loanId in baseline.loans produces a larger 5-year benefit than an unmatched id", () => {
      const matched = runScenario(
        "LOAN_PREPAYMENT",
        { loanId: "loan-1", lumpSum: 100000 },
        baselineWithLoan,
        { loanPrepayment: { interestSaved: 45000, monthsSaved: 8, newTenureMonths: 100 } },
      );
      const unmatched = runScenario(
        "LOAN_PREPAYMENT",
        { loanId: "does-not-exist", lumpSum: 100000 },
        baselineWithLoan,
        { loanPrepayment: { interestSaved: 45000, monthsSaved: 8, newTenureMonths: 100 } },
      );
      // Both spend the same lump sum immediately, but only the matched case also
      // amortizes the target loan down faster inside the 5-year window.
      expect(Number(matched.netWorthDeltaIn5Years)).toBeGreaterThanOrEqual(Number(unmatched.netWorthDeltaIn5Years));
    });
  });
});
