import { Prisma } from "@wealthos/db";
import { GoalDTO } from "@wealthos/types";
import {
  assessEmergencyFund,
  assessGoal,
  assessHousePurchase,
  buildCategoryBreakdown,
  compareCategories,
  compareSipIncrease,
  computeSavingsRate,
  emiToIncomeRatio,
  matchCategories,
  monthStatus,
  monthsToReach,
  recorded,
  requiredMonthlyContribution,
  round2,
} from "../src/ai/coach/analysis/coach-metrics";
import { projectGrowth } from "../src/common/financial-facts/financial-formulas";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const NOW = new Date("2026-10-14T06:00:00.000Z");

describe("monthStatus", () => {
  it("flags past, current and future months", () => {
    expect(monthStatus("2026-09", NOW)).toMatchObject({ complete: true, daysElapsed: 30, daysInMonth: 30 });
    expect(monthStatus("2026-10", NOW)).toMatchObject({ complete: false, daysElapsed: 14, daysInMonth: 31 });
    expect(monthStatus("2026-11", NOW)).toMatchObject({ isFuture: true });
    expect(monthStatus("2028-02", new Date("2029-01-01T00:00:00Z")).daysInMonth).toBe(29);
  });
});

describe("computeSavingsRate", () => {
  const sep = monthStatus("2026-09", NOW);
  const oct = monthStatus("2026-10", NOW);
  it("(income - spending) / income on a complete month: (100000-60000)/100000 = 40%", () => {
    const r = computeSavingsRate(recorded([100000]), recorded([20000, 40000]), sep);
    expect(r.rate!.toNumber()).toBeCloseTo(0.4, 10);
    expect(r.estimate).toBe(false);
  });
  it("marks a running month as an estimate", () => {
    const r = computeSavingsRate(recorded([100000]), recorded([10000]), oct);
    expect(r.rate!.toNumber()).toBeCloseTo(0.9, 10);
    expect(r.estimate).toBe(true);
  });
  it("missing income is not zero income", () => {
    expect(computeSavingsRate(recorded([]), recorded([5000]), sep)).toMatchObject({ rate: null, reason: "NO_INCOME_RECORDED" });
  });
  it("no expense records is not zero spending", () => {
    expect(computeSavingsRate(recorded([100000]), recorded([]), sep)).toMatchObject({ rate: null, reason: "NO_EXPENSES_RECORDED" });
  });
  it("a negative rate is reported, not clamped", () => {
    expect(computeSavingsRate(recorded([50000]), recorded([60000]), sep).rate!.toNumber()).toBeCloseTo(-0.2, 10);
  });
});

describe("buildCategoryBreakdown", () => {
  const rows = [
    { amount: "1200.50", currency: "INR", categoryName: "Food", categoryType: "NEED" },
    { amount: "800", currency: "INR", categoryName: "Food", categoryType: "NEED" },
    { amount: "5000", currency: "INR", categoryName: "Rent", categoryType: "NEED" },
    { amount: "10000", currency: "INR", categoryName: "SIP", categoryType: "SAVINGS" },
    { amount: "50", currency: "USD", categoryName: "Food", categoryType: "NEED" },
    { amount: "999", currency: "INR", categoryName: "Misc", categoryType: "WANT", flowType: "OTHER_OUTFLOW" },
  ];
  const b = buildCategoryBreakdown(rows);
  it("sums genuine INR spending only, with exact decimals", () => {
    expect(b.total.toString()).toBe("7000.5");
    expect(b.categories.map((c) => [c.name, c.total.toString()])).toEqual([["Rent", "5000"], ["Food", "2000.5"]]);
  });
  it("reports exclusions instead of hiding them", () => {
    expect(b.excluded.savingsCount).toBe(1);
    expect(b.excluded.savingsTotal.toString()).toBe("10000");
    expect(b.excluded.foreignCurrency).toEqual([{ currency: "USD", count: 1 }]);
    expect(b.excluded.otherFlowCount).toBe(1);
  });
  it("shares sum to 1", () => {
    expect(b.categories.reduce((s, c) => s.plus(c.share), D(0)).toNumber()).toBeCloseTo(1, 10);
  });
  it("compareCategories flags significant increases between comparable months", () => {
    const prev = buildCategoryBreakdown([{ amount: 1000, categoryName: "Food", categoryType: "NEED" }, { amount: 5000, categoryName: "Rent", categoryType: "NEED" }]);
    const cur = buildCategoryBreakdown([{ amount: 2500, categoryName: "Food", categoryType: "NEED" }, { amount: 5100, categoryName: "Rent", categoryType: "NEED" }]);
    const changes = compareCategories(cur, prev);
    expect(changes[0]).toMatchObject({ name: "Food", significant: true });
    expect(changes.find((c) => c.name === "Rent")!.significant).toBe(false);
  });
});

describe("matchCategories", () => {
  const names = ["Food & Dining", "Groceries", "Current Account Fees", "Rent", "Utilities", "Transport"];
  it("matches aliases on whole words / prefixes", () => {
    expect(matchCategories("food", names)).toEqual(["Food & Dining", "Groceries"]);
    expect(matchCategories("rent", names)).toEqual(["Rent"]);
    expect(matchCategories("bills", names)).toContain("Utilities");
  });
  it("returns nothing (not zero spend) when no category matches", () => {
    expect(matchCategories("pets", names)).toEqual([]);
  });
});

describe("assessEmergencyFund", () => {
  it("6 months of cover = adequate", () => {
    const a = assessEmergencyFund({ balance: 300000, avgMonthlyEssential: 50000, monthsOfData: 3 });
    expect(a.coverageMonths!.toNumber()).toBe(6);
    expect(a.verdict).toBe("adequate");
    expect(a.shortfall!.toNumber()).toBe(0);
    expect(a.targetIsDefault).toBe(true);
  });
  it("2.4 months vs 6-month target: low, shortfall 180000", () => {
    const a = assessEmergencyFund({ balance: 120000, avgMonthlyEssential: 50000, monthsOfData: 3 });
    expect(a.coverageMonths!.toNumber()).toBeCloseTo(2.4, 10);
    expect(a.verdict).toBe("low");
    expect(a.shortfall!.toNumber()).toBe(180000);
  });
  it("uses the user's own target in preference to the default", () => {
    const a = assessEmergencyFund({ balance: 120000, avgMonthlyEssential: 50000, monthsOfData: 3, userTargetMonths: 3 });
    expect(a.targetIsDefault).toBe(false);
    expect(a.verdict).toBe("partial");
    expect(a.shortfall!.toNumber()).toBe(30000);
  });
  it("no essential-expense baseline = unknown coverage, never infinite or zero", () => {
    const a = assessEmergencyFund({ balance: 100000, avgMonthlyEssential: 0, monthsOfData: 0 });
    expect(a.coverageMonths).toBeNull();
    expect(a.verdict).toBe("unknown");
  });
});

describe("emiToIncomeRatio", () => {
  it("is EMI/income, null without income", () => {
    expect(emiToIncomeRatio(20000, 80000)!.toNumber()).toBe(0.25);
    expect(emiToIncomeRatio(20000, 0)).toBeNull();
    expect(emiToIncomeRatio(20000, null)).toBeNull();
  });
});

describe("assessGoal", () => {
  const goal = (over: Partial<GoalDTO>): GoalDTO =>
    ({ id: "g1", userId: "u", type: "CUSTOM", name: "Car", targetAmount: "500000.00", targetDate: "2027-10-14T00:00:00.000Z", currentAmount: "100000.00", monthlyContribution: "20000.00",
      linkedInvestmentValue: "0.00", requiredMonthlyContribution: 33333.33, progressPercent: 20, probabilityOfSuccess: "AT_RISK", contributionPaceRatio: 0.6, isPaceHeuristic: true,
      projectedInvestmentValueAtTarget: "0.00", assumedAnnualReturnPercent: "0.00", ...over }) as GoalDTO;

  it("active goal reuses the Goals module's requirement and computes pace 20000/33333.33 = 0.6", () => {
    const a = assessGoal(goal({}), NOW);
    expect(a.state).toBe("ACTIVE");
    expect(a.paceRatio).toBeCloseTo(0.6, 3);
    expect(a.onTrack).toBe(false);
    expect(a.monthsLeft).toBe(12);
  });
  it("fully funded goal with a stale requirement needs 0 and is flagged stale", () => {
    const a = assessGoal(goal({ currentAmount: "400000.00", linkedInvestmentValue: "100000.00", requiredMonthlyContribution: 8000, progressPercent: 100 }), NOW);
    expect(a.state).toBe("FUNDED");
    expect(a.requiredMonthly).toBe(0);
    expect(a.staleRequirement).toBe(true);
    expect(a.onTrack).toBe(true);
  });
  it("overdue goal gets no invented monthly requirement", () => {
    const a = assessGoal(goal({ targetDate: "2026-06-01T00:00:00.000Z", requiredMonthlyContribution: 400000 }), NOW);
    expect(a.state).toBe("OVERDUE");
    expect(a.requiredMonthly).toBeNull();
    expect(a.onTrack).toBe(false);
  });
});

describe("growth and contributions (independent closed-form checks)", () => {
  it("SIP: ₹10,000/month at 12% for 10 years, contributions at the start of each month = ₹23,23,391", () => {
    const c = compareSipIncrease({ currentValue: 0, currentSip: 5000, increase: 5000, annualReturnPercent: 12, years: 10 });
    expect(round2(c.proposed.projectedValue)).toBeCloseTo(2323391, -1);
    // Independent annuity-due: 5000 * ((1.01^120 - 1)/0.01) * 1.01
    const ind = 5000 * ((Math.pow(1.01, 120) - 1) / 0.01) * 1.01;
    expect(c.baseline.projectedValue.toNumber()).toBeCloseTo(ind, 0);
    expect(c.extraProjectedValue.toNumber()).toBeCloseTo(ind, 0); // doubling the SIP doubles the pot when starting from zero
    expect(c.extraContributions.toNumber()).toBe(600000);
  });
  it("required monthly: ₹10 lakh in 36 months at 12% = 1,000,000 / 43.5076472 = ₹22,984", () => {
    const req = requiredMonthlyContribution({ target: 1_000_000, currentValue: 0, annualReturnPercent: 12, months: 36 })!;
    const factor = ((Math.pow(1.01, 36) - 1) / 0.01) * 1.01;
    expect(req.toNumber()).toBeCloseTo(1_000_000 / factor, 4);
    expect(req.toNumber()).toBeCloseTo(22984.3, 0);
  });
  it("round trip: investing the required amount reaches the target", () => {
    const req = requiredMonthlyContribution({ target: 1_000_000, currentValue: 50_000, annualReturnPercent: 10, months: 36 })!;
    const p = projectGrowth({ currentValue: D(50_000), contributionPerPeriod: req, cadence: "MONTHLY", annualReturnPercent: D(10), years: 3 });
    expect(p.projectedValue.toNumber()).toBeCloseTo(1_000_000, 4);
  });
  it("zero return = plain division; already reached = 0; no time = null", () => {
    expect(requiredMonthlyContribution({ target: 120000, currentValue: 0, annualReturnPercent: 0, months: 12 })!.toNumber()).toBe(10000);
    expect(requiredMonthlyContribution({ target: 100, currentValue: 500, annualReturnPercent: 8, months: 12 })!.toNumber()).toBe(0);
    expect(requiredMonthlyContribution({ target: 100, currentValue: 0, annualReturnPercent: 8, months: 0 })).toBeNull();
  });
  it("monthsToReach is consistent with requiredMonthlyContribution", () => {
    expect(monthsToReach({ target: 1_000_000, currentValue: 0, monthly: 22985, annualReturnPercent: 12 })).toBe(36);
    expect(monthsToReach({ target: 1_000_000, currentValue: 0, monthly: 22984, annualReturnPercent: 12 })).toBe(37); // one rupee short of the exact requirement needs one more month
    expect(monthsToReach({ target: 1_000_000, currentValue: 0, monthly: 0, annualReturnPercent: 0 })).toBeNull();
    expect(monthsToReach({ target: 10, currentValue: 10, monthly: 0, annualReturnPercent: 0 })).toBe(0);
  });
});

describe("assessHousePurchase", () => {
  const emi = (p: number, ratePct: number, n: number) => { const r = ratePct / 1200; return (p * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1); };
  const base = { price: 4_000_000, downPaymentPercent: 20, annualRatePercent: 8.5, tenureYears: 20 };

  it("EMI matches the closed form for ₹32 lakh at 8.5% over 240 months", () => {
    const h = assessHousePurchase({ ...base, monthlyIncome: 200000, monthlySpending: 60000, existingMonthlyEmi: 0, availableCash: 2_000_000, emergencyTargetAmount: 300000 });
    expect(h.downPayment.toNumber()).toBe(800000);
    expect(h.newEmi.toNumber()).toBeCloseTo(emi(3_200_000, 8.5, 240), 2);
    expect(h.verdict).toBe("comfortable");
  });
  it("down payment beyond available cash = not affordable", () => {
    const h = assessHousePurchase({ ...base, monthlyIncome: 200000, monthlySpending: 60000, existingMonthlyEmi: 0, availableCash: 500000, emergencyTargetAmount: 300000 });
    expect(h.verdict).toBe("not_affordable");
    expect(h.reasons.join(" ")).toMatch(/down payment/);
  });
  it("EMI load above 40% of income = stretch", () => {
    const h = assessHousePurchase({ ...base, monthlyIncome: 80000, monthlySpending: 20000, existingMonthlyEmi: 5000, availableCash: 2_000_000, emergencyTargetAmount: 100000 });
    expect(h.emiToIncomeAfter!.toNumber()).toBeGreaterThan(0.4);
    expect(h.verdict).toBe("stretch");
  });
  it("cash left below the emergency target = stretch", () => {
    const h = assessHousePurchase({ ...base, monthlyIncome: 300000, monthlySpending: 60000, existingMonthlyEmi: 0, availableCash: 900000, emergencyTargetAmount: 300000 });
    expect(h.cashAfterDownPayment!.toNumber()).toBe(100000);
    expect(h.shortfallVsEmergencyTarget!.toNumber()).toBe(200000);
    expect(h.verdict).toBe("stretch");
  });
  it("missing income or cash = unknown, never a made-up verdict", () => {
    expect(assessHousePurchase({ ...base, monthlyIncome: null, monthlySpending: null, existingMonthlyEmi: 0, availableCash: null, emergencyTargetAmount: null }).verdict).toBe("unknown");
  });
});
