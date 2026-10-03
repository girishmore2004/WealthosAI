import { Prisma } from "@wealthos/db";
import {
  addCashflow,
  computeCashModel,
  computeNetWorth,
  deriveInvestmentMetrics,
  emergencyAvailableCashDelta,
  emergencyCash,
  emergencyCoverageMonths,
  emptyCashflowTotals,
  expenseRate,
  formatRatioAsPercent,
  investmentCashInflow,
  investmentCashOutflow,
  investmentRate,
  savingsRate,
  toMoneyString,
  ZERO,
} from "../src/common/financial-facts/financial-formulas";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

describe("financial-formulas", () => {
  // Spec §58: income 65,000, expenses 15,000, investment 10,000, emergency allocation 7,000.
  describe("required financial scenario", () => {
    const totals = addCashflow(emptyCashflowTotals(), "CONTRIBUTION", 10000);
    const entries = [{ type: "ALLOCATE" as const, amount: 7000 }];
    const cash = computeCashModel({
      income: D(65000),
      expenses: D(15000),
      investmentCashOutflow: investmentCashOutflow(totals),
      investmentCashInflow: investmentCashInflow(totals),
      emergencyAvailableCashDelta: entries.reduce((a, e) => a.plus(emergencyAvailableCashDelta(e)), ZERO),
      emergencyCashAmount: emergencyCash(entries),
      unclassifiedOutflow: ZERO,
    });

    it("splits cash into Available / Emergency / Total", () => {
      expect(toMoneyString(cash.availableCash)).toBe("33000.00");
      expect(toMoneyString(cash.emergencyCash)).toBe("7000.00");
      expect(toMoneyString(cash.totalCash)).toBe("40000.00");
    });

    it("computes savings rate ≈ 76.92% and investment rate ≈ 15.38% as ratios", () => {
      const sr = savingsRate(D(65000), D(15000))!;
      const ir = investmentRate(D(10000), D(65000))!;
      expect(sr.toNumber()).toBeCloseTo(0.769231, 5);
      expect(ir.toNumber()).toBeCloseTo(0.153846, 5);
      expect(formatRatioAsPercent(sr)).toBe("76.92%");
      expect(formatRatioAsPercent(ir)).toBe("15.38%");
      expect(expenseRate(D(15000), D(65000))!.toNumber()).toBeCloseTo(0.230769, 5);
    });

    it("never produces 2500% for a 0.25 ratio", () => {
      expect(formatRatioAsPercent(D(0.25))).toBe("25.00%");
      expect(savingsRate(D(100), D(75))!.toString()).toBe("0.25");
    });

    it("returns null rates (not NaN/Infinity) when income is zero", () => {
      expect(savingsRate(ZERO, D(10))).toBeNull();
      expect(investmentRate(D(10), ZERO)).toBeNull();
    });

    it("an emergency allocation does not reduce net worth", () => {
      const withReserve = computeNetWorth({
        availableCash: cash.availableCash, emergencyCash: cash.emergencyCash, investments: D(10000),
        property: ZERO, business: ZERO, otherAssets: ZERO, loans: ZERO, creditCardOutstanding: ZERO, otherLiabilities: ZERO,
      });
      const beforeAllocation = computeNetWorth({
        availableCash: D(40000), emergencyCash: ZERO, investments: D(10000),
        property: ZERO, business: ZERO, otherAssets: ZERO, loans: ZERO, creditCardOutstanding: ZERO, otherLiabilities: ZERO,
      });
      expect(withReserve.netWorth.toString()).toBe(beforeAllocation.netWorth.toString());
    });
  });

  describe("emergency reserve", () => {
    it("RELEASE moves cash back to available; the later spend is a separate Expense", () => {
      const release = { type: "RELEASE" as const, amount: 5000 };
      expect(emergencyAvailableCashDelta(release).toNumber()).toBe(5000);
      expect(emergencyCash([{ type: "ALLOCATE", amount: 7000 }, release]).toNumber()).toBe(2000);
    });

    it("coverage = emergency cash / average MONTHLY essential expenses (no extra /12)", () => {
      expect(emergencyCoverageMonths(D(60000), D(10000))!.toNumber()).toBe(6);
      expect(emergencyCoverageMonths(D(60000), ZERO)).toBeNull();
    });
  });

  describe("investment metrics", () => {
    it("EPF: employee 5,000 + employer 5,000 + interest 1,000 → value 11,000, user cash out only 5,000", () => {
      let t = emptyCashflowTotals();
      t = addCashflow(t, "CONTRIBUTION", 5000);
      t = addCashflow(t, "EMPLOYER_CONTRIBUTION", 5000);
      t = addCashflow(t, "INTEREST", 1000);

      expect(investmentCashOutflow(t).toNumber()).toBe(5000);
      const m = deriveInvestmentMetrics({ totals: t, currentValue: D(11000), realizedCostBasisSold: ZERO, realizedGain: ZERO });
      expect(m.currentValue.toNumber()).toBe(11000);
      expect(m.totalReturn.toNumber()).toBe(1000); // = interest; employer money is not "profit"
      expect(m.costBasis.toNumber()).toBe(10000);
    });

    it("is not 'current value minus all historical deposits' once withdrawals exist", () => {
      let t = emptyCashflowTotals();
      t = addCashflow(t, "CONTRIBUTION", 100000);
      t = addCashflow(t, "WITHDRAWAL", 40000);
      const m = deriveInvestmentMetrics({ totals: t, currentValue: D(70000), realizedCostBasisSold: ZERO, realizedGain: ZERO });
      expect(m.netContributions.toNumber()).toBe(60000);
      expect(m.totalReturn.toNumber()).toBe(10000); // 70,000 + 40,000 − 100,000, not −30,000
    });

    it("separates realized and unrealized gain after a partial sale", () => {
      let t = emptyCashflowTotals();
      t = addCashflow(t, "CONTRIBUTION", 100000);
      t = addCashflow(t, "SALE", 60000);
      const m = deriveInvestmentMetrics({
        totals: t, currentValue: D(70000), realizedCostBasisSold: D(50000), realizedGain: D(10000),
      });
      expect(m.costBasis.toNumber()).toBe(50000);
      expect(m.unrealizedGain.toNumber()).toBe(20000);
      expect(m.realizedGain.toNumber()).toBe(10000);
      expect(m.totalReturn.toNumber()).toBe(30000);
    });

    it("SIP contribution is a cash outflow to investments, never an expense input", () => {
      const t = addCashflow(emptyCashflowTotals(), "CONTRIBUTION", 10000);
      const cash = computeCashModel({
        income: D(65000), expenses: D(15000),
        investmentCashOutflow: investmentCashOutflow(t), investmentCashInflow: investmentCashInflow(t),
        emergencyAvailableCashDelta: ZERO, emergencyCashAmount: ZERO, unclassifiedOutflow: ZERO,
      });
      expect(cash.availableCash.toNumber()).toBe(40000);
    });
  });

  describe("net worth and decimal safety", () => {
    it("net worth = assets − liabilities", () => {
      const nw = computeNetWorth({
        availableCash: D(33000), emergencyCash: D(7000), investments: D(100000), property: D(500000), business: ZERO,
        otherAssets: ZERO, loans: D(200000), creditCardOutstanding: D(5000), otherLiabilities: ZERO,
      });
      expect(nw.totalAssets.toNumber()).toBe(640000);
      expect(nw.totalLiabilities.toNumber()).toBe(205000);
      expect(nw.netWorth.toNumber()).toBe(435000);
    });

    it("avoids binary floating-point drift", () => {
      expect(toMoneyString(D(0.1).plus(D(0.2)))).toBe("0.30");
    });

    it("unmigrated legacy SAVINGS rows still leave cash, but are not expenses", () => {
      const cash = computeCashModel({
        income: D(65000), expenses: D(15000), investmentCashOutflow: ZERO, investmentCashInflow: ZERO,
        emergencyAvailableCashDelta: ZERO, emergencyCashAmount: ZERO, unclassifiedOutflow: D(10000),
      });
      expect(cash.availableCash.toNumber()).toBe(40000);
    });
  });
});
