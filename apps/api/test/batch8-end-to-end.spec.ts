import { FinancialFactsService } from "../src/common/financial-facts/financial-facts.service";
import { DashboardOverviewService } from "../src/dashboard/dashboard-overview.service";
import { ReportsService } from "../src/reports/reports.service";
import { FinancialToolsService } from "../src/ai/financial-engine/financial-tools.service";
import { FinancialEngineService } from "../src/ai/financial-engine/financial-engine.service";
import { InvestmentProjectionService } from "../src/investments/investment-projection.service";

// ---------------------------------------------------------------------------------------
// Spec Parts 55-63, end to end: ONE fake database, the REAL FinancialFactsService, and the
// dashboard, the monthly report and the AI engine all reading it. The scenario:
//   income 65,000 · expenses 15,000 · investment 10,000 · emergency fund 7,000 ·
//   receivable 5,000 · internal transfer 3,000
// The three surfaces must show the same numbers, keep the six flows separate and never
// report "expenses = 40,000".
// ---------------------------------------------------------------------------------------

interface Scenario {
  income: number;
  expenses: number;
  contributions?: number;
  emergency?: number;
  receivableGiven?: number;
  transfers?: number;
}

function fakeFacts(sc: Scenario) {
  const sum = (n: number | undefined) => ({ _sum: { amount: n ?? null } });
  const db = {
    income: { aggregate: jest.fn(async () => sum(sc.income)) },
    expense: {
      aggregate: jest.fn(async ({ where }: any) => sum(where.flowType === "OTHER_OUTFLOW" ? 0 : sc.expenses)),
      findMany: jest.fn().mockResolvedValue([]),
    },
    investmentCashflow: {
      groupBy: jest.fn(async () => (sc.contributions ? [{ type: "CONTRIBUTION", _sum: { amount: sc.contributions } }] : [])),
      findMany: jest.fn().mockResolvedValue([]),
    },
    emergencyFundEntry: {
      groupBy: jest.fn(async ({ where }: any) =>
        sc.emergency && (!where.type || where.type === "ALLOCATE") ? [{ type: "ALLOCATE", _sum: { amount: sc.emergency } }] : [],
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    investment: {
      findMany: jest.fn(async () => (sc.contributions ? [{ id: "i1", currentValue: 0, valuations: [{ value: sc.contributions, valuedAt: new Date() }] }] : [])),
    },
    property: { aggregate: jest.fn(async () => ({ _sum: { currentValue: null } })) },
    loan: { aggregate: jest.fn(async () => ({ _sum: { outstandingPrincipal: null } })) },
    receivable: { aggregate: jest.fn(async () => ({ _sum: { originalAmount: sc.receivableGiven ?? null } })) },
    receivableRepayment: { aggregate: jest.fn(async () => sum(0)) },
    accountTransfer: { aggregate: jest.fn(async () => sum(sc.transfers)) },
  };
  return new FinancialFactsService({ client: db } as never, {} as never, {} as never);
}

const SCENARIO: Scenario = { income: 65000, expenses: 15000, contributions: 10000, emergency: 7000, receivableGiven: 5000, transfers: 3000 };

function analyticsFor(total: string) {
  return {
    basis: "ACTUAL",
    currency: "INR",
    period: { from: "2026-10-01", to: "2026-10-31", days: 31, elapsedDays: 15 },
    filters: { categoryId: null, flowType: "EXPENSE" },
    totals: { total, transactionCount: 6, averagePerTransaction: "2500.00", averagePerDay: "1000.00", largest: { id: "e1", amount: "6000.00", spentAt: "2026-10-03T00:00:00.000Z", merchant: "Rent", categoryName: "Housing" }, smallest: null },
    highestDay: { date: "2026-10-03", total: "6000.00" },
    lowestDay: null,
    daily: [{ date: "2026-10-03", total: "6000.00", count: 1 }],
    weekly: [],
    monthly: [],
    categories: [
      { categoryId: "c1", name: "Housing", type: "NEED", icon: null, total: "9000.00", count: 2, sharePercent: 60, previousTotal: "7500.00", changePercent: 20 },
      { categoryId: "c2", name: "Entertainment", type: "WANT", icon: null, total: "6000.00", count: 4, sharePercent: 40, previousTotal: "6000.00", changePercent: 0 },
    ],
    comparison: { from: "2026-09-01", to: "2026-09-30", total: "12000.00", change: "3000.00", changePercent: 25 },
    yearOverYear: null,
    overall: null,
  };
}

function buildAll(sc: Scenario = SCENARIO) {
  const facts = fakeFacts(sc);
  jest.spyOn(facts, "getEmergencyCoverage").mockResolvedValue({
    basis: "ACTUAL", period: "LIFETIME", asOfDate: new Date().toISOString(), currency: "INR",
    emergencyCash: String(sc.emergency ?? 0) + ".00", avgMonthlyEssentialExpenses: "25000.00", coverageMonths: "0.28", monthsOfData: 3,
  } as never);

  const expenses = {
    analytics: jest.fn(async () => analyticsFor(String(sc.expenses) + ".00")),
    periodTotals: jest.fn(async () => ({ basis: "ACTUAL", currency: "INR", date: "2026-10-15", flowType: "EXPENSE", today: "500.00", month: String(sc.expenses) + ".00", year: "90000.00" })),
    recurringSplit: jest.fn(async () => ({ recurring: "6000.00", oneTime: "9000.00", recurringPercent: 40 })),
    largestTransactions: jest.fn(async () => []),
  };
  const emergency = {
    overview: jest.fn(async () => ({
      balance: String(sc.emergency ?? 0) + ".00",
      coverage: { months: "0.28", avgMonthlyEssentialExpenses: "25000.00", monthsOfData: 3 },
      target: { basis: "TARGET", mode: "MONTHS", amount: "150000.00", months: "6", needsExpenseHistory: false },
      progress: { percent: 4.7, remaining: "143000.00", reached: false },
      totals: { contributions: "7000.00", withdrawals: "0.00", adjustments: "0.00", contributedThisMonth: "7000.00", contributedThisYear: "7000.00", withdrawnThisYear: "0.00" },
    })),
  };
  const receivables = {
    summary: jest.fn(async () => ({
      basis: "ACTUAL", currency: "INR", totalOutstanding: String(sc.receivableGiven ?? 0) + ".00", activeCount: sc.receivableGiven ? 1 : 0,
      dueSoon: { amount: "0.00", count: 0, withinDays: 7 }, overdue: { amount: "0.00", count: 0 }, returnedThisMonth: "0.00", largest: null,
    })),
  };
  const investmentAnalytics = {
    analytics: jest.fn(async () => ({
      overview: { holdings: 1, holdingsWithLedger: 1, activeSchedules: 1, plannedMonthlyContribution: "10000.00", plannedAnnualContribution: "120000.00", actualContributionsThisMonth: "10000.00", actualContributionsThisYear: "10000.00" },
    })),
  };
  // The portfolio projection is the real deterministic formula, wrapped the way the real service wraps it.
  const projectionReal = new InvestmentProjectionService({} as never);
  const projection = {
    portfolio: jest.fn(async (_u: string, q: { years?: number[]; annualReturn?: number }) => {
      const years = q.years ?? [10];
      const calc = projectionReal.calculate({ currentValue: 0, contribution: 10000, frequency: "MONTHLY", annualReturn: q.annualReturn ?? 0, years } as never);
      return {
        basis: "PROJECTED", disclaimer: "A projection, not a promise.",
        actual: { basis: "ACTUAL", currentValue: "0.00", holdings: 1 },
        defaultAnnualReturnPercent: null, includedValueToday: "0.00", scenarios: calc.scenarios, curve: [], holdings: [],
        includedCount: q.annualReturn === undefined ? 0 : 1, excludedCount: q.annualReturn === undefined ? 1 : 0,
      };
    }),
  };

  const overviewSvc = new DashboardOverviewService(facts, expenses as never, emergency as never, receivables as never, investmentAnalytics as never);
  const reports = new ReportsService({} as never, {} as never, expenses as never, {} as never, {} as never, {} as never, facts);
  const tools = new FinancialToolsService(
    facts,
    { getReport: jest.fn(async () => ({ asOfDate: new Date().toISOString(), issues: [] })) } as never,
    {} as never,
    {} as never,
    expenses as never,
    receivables as never,
    emergency as never,
    investmentAnalytics as never,
    projection as never,
  );
  return { facts, overviewSvc, reports, engine: new FinancialEngineService(tools), projection, expenses };
}

const NOW = new Date("2026-10-15T10:00:00.000Z");

describe("Batch 8 — dashboard, report and AI Coach agree (spec Parts 55-63)", () => {
  it("dashboard overview keeps all six flows separate", async () => {
    const { overviewSvc } = buildAll();
    const o = await overviewSvc.overview("u1", NOW);
    expect(o.moneyFlow.income).toBe("65000.00");
    expect(o.moneyFlow.outflows).toEqual({ expenses: "15000.00", investments: "10000.00", emergencyFund: "7000.00", receivablesGiven: "5000.00", otherOutflow: "0.00" });
    expect(o.moneyFlow.internalTransfers).toBe("3000.00");
    expect(o.moneyFlow.outflows.expenses).not.toBe("40000.00");
    expect(o.moneyFlow.totalGenuineOutflow).toBe("37000.00");
    expect(o.moneyFlow.netCashFlow).toBe("28000.00");
  });

  it("dashboard and monthly report show the identical money flow", async () => {
    const { overviewSvc, reports } = buildAll();
    const [o, r] = await Promise.all([overviewSvc.overview("u1", NOW), reports.monthlyDetail("u1", "2026-10", NOW)]);
    // asOfDate is the instant each call ran, so it is the one field allowed to differ.
    const { asOfDate: _a, ...reportFlow } = r.moneyFlow;
    const { asOfDate: _b, ...dashboardFlow } = o.moneyFlow;
    expect(reportFlow).toEqual(dashboardFlow);
    expect(r.income).toBe(o.moneyFlow.income);
    expect(r.expenses).toBe(o.moneyFlow.outflows.expenses);
    expect(r.investments).toBe(o.moneyFlow.outflows.investments);
    expect(r.emergencyFund).toBe(o.moneyFlow.outflows.emergencyFund);
    expect(r.receivablesGiven).toBe(o.moneyFlow.outflows.receivablesGiven);
    expect(r.internalTransfers).toBe(o.moneyFlow.internalTransfers);
    expect(r.netCashFlow).toBe(o.moneyFlow.netCashFlow);
    expect(r.savingsRate).toBe(o.savingsRate);
  });

  it("savings rate is the ACTUAL rate: 76.9% here, negative when spending exceeds income, null with no income", async () => {
    const ok = await buildAll().overviewSvc.overview("u1", NOW);
    expect(ok.savingsRate).toBe(76.9);
    expect(ok.expenseRate).toBe(23.1);
    expect(ok.investmentRate).toBe(15.4);

    const over = await buildAll({ income: 10000, expenses: 15000 }).overviewSvc.overview("u1", NOW);
    expect(over.savingsRate).toBe(-50); // not clamped to 0

    const none = await buildAll({ income: 0, expenses: 500 }).overviewSvc.overview("u1", NOW);
    expect(none.savingsRate).toBeNull();
    expect(none.expenseRate).toBeNull();
  });

  it("the narrative is built from the numbers and states what each flow is not", async () => {
    const { reports } = buildAll();
    const r = await reports.monthlyDetail("u1", "2026-10", NOW);
    expect(r.narrative[0]).toBe("Your October expenses were ₹15,000, representing 23.1% of your ₹65,000 income.");
    const text = r.narrative.join(" ");
    expect(text).toContain("You invested ₹10,000 in October, which is 15.4% of your income. Investments are not counted as expenses.");
    expect(text).toContain("₹7,000 to your emergency fund");
    expect(text).toContain("You lent ₹5,000 to others. It is not an expense");
    expect(text).toContain("₹3,000 moved between your own accounts");
    expect(text).toContain("net cash flow for October was ₹28,000");
    expect(text).toContain("Housing was your biggest spending category at ₹9,000, 60% of your expenses.");
    expect(text).toContain("Spending was 25% higher than September.");
    expect(text).not.toContain("40,000");
  });

  it("report extras: category change, recurring split, estimated net-worth change", async () => {
    const { reports } = buildAll();
    const r = await reports.monthlyDetail("u1", "2026-10", NOW);
    expect(r.categories[0]).toMatchObject({ category: "Housing", amount: "9000.00", previousAmount: "7500.00", changePercent: 20 });
    expect(r.recurringVsOneTime).toEqual({ recurring: "6000.00", oneTime: "9000.00", recurringPercent: 40 });
    // 65,000 income - 15,000 expenses: the investment, the reserve and the loan are still assets.
    expect(r.netWorthChange).toMatchObject({ basis: "ESTIMATED", amount: "50000.00" });
  });

  it("yearly report: twelve months, future months are zero, totals add up", async () => {
    const { reports } = buildAll();
    const y = await reports.yearlyMonths("u1", "2026", NOW);
    expect(y.months).toHaveLength(12);
    expect(y.months[0].month).toBe("2026-01");
    expect(y.months[11].month).toBe("2026-12");
    expect(y.months[10].income).toBe("0.00"); // November is in the future
    expect(y.months[11].expenses).toBe("0.00");
    // January to October each read the same fake month (10 months of activity).
    expect(y.totals.income).toBe("650000.00");
    expect(y.totals.expenses).toBe("150000.00");
    expect(y.totals.investments).toBe("100000.00");
    expect(y.narrative[0]).toContain("In 2026 you recorded ₹6,50,000 of income and ₹1,50,000 of expenses across 10 months");
  });

  it("rejects a malformed year or month", async () => {
    const { reports } = buildAll();
    await expect(reports.yearlyMonths("u1", "26")).rejects.toThrow(/4-digit year/);
    await expect(reports.monthlyDetail("u1", "2026-13")).rejects.toThrow(/YYYY-MM/);
  });

  it("AI Coach: the same savings rate and invested amount as the dashboard", async () => {
    const { engine, overviewSvc } = buildAll();
    const o = await overviewSvc.overview("u1", NOW);
    const rate = await engine.ask("u1", "What is my savings rate?");
    expect(rate.usedFallback).toBe(false);
    expect(rate.verification.passed).toBe(true);
    expect(rate.answer).toContain(`${o.savingsRate}%`);
    const inv = await engine.ask("u1", "How much did I invest this month?");
    expect(inv.answer).toContain("₹10,000");
    expect(inv.verification.passed).toBe(true);
  });

  it("AI Coach: receivables, emergency fund and expense breakdown come from the same facts", async () => {
    const { engine } = buildAll();
    const recv = await engine.ask("u1", "How much money do people owe me?");
    expect(recv.intent).toBe("RECEIVABLES");
    expect(recv.answer).toContain("₹5,000");
    expect(recv.answer).toContain("not an expense");
    expect(recv.verification.passed).toBe(true);

    const em = await engine.ask("u1", "How is my emergency fund doing?");
    expect(em.answer).toContain("₹7,000");
    expect(em.answer).toContain("target is ₹1,50,000");
    expect(em.verification.passed).toBe(true);
    expect(em.usedFallback).toBe(false);

    const br = await engine.ask("u1", "What is my daily average spending?");
    expect(br.intent).toBe("EXPENSE_BREAKDOWN");
    expect(br.answer).toContain("₹1,000 per day");
    expect(br.answer).toContain("Housing is your biggest category at ₹9,000");
    expect(br.answer).toContain("up 20.0% from last month");
    expect(br.verification.passed).toBe(true);
    expect(br.usedFallback).toBe(false);
  });

  it("AI Coach: 'this year' questions use yearly facts, not this month's", async () => {
    const { engine } = buildAll();
    const spent = await engine.ask("u1", "How much did I spend this year?");
    expect(spent.answer).toContain("₹90,000");
    expect(spent.tools[0].period).toBe("YEARLY");
    expect(spent.verification.passed).toBe(true);
  });

  it("AI Coach: 'what will my SIP become in 10 years' is a labelled PROJECTION from the real formula", async () => {
    const { engine } = buildAll();
    const res = await engine.ask("u1", "What will my SIP become in 10 years at 12%?");
    expect(res.intent).toBe("INVESTMENT_PROJECTION");
    expect(res.tools[0].basis).toBe("PROJECTED");
    expect(res.answer).toMatch(/^Projected, not a promise/);
    expect(res.answer).toContain("₹23,23,391"); // ₹10,000 / month at 12% for 10 years, contributions at period start
    expect(res.verification.passed).toBe(true);
    expect(res.usedFallback).toBe(false);
  });

  it("AI Coach: without an expected return it asks for one instead of inventing a figure", async () => {
    const { engine } = buildAll();
    const res = await engine.ask("u1", "What will my SIP be worth in 10 years?");
    expect(res.intent).toBe("INVESTMENT_PROJECTION");
    expect(res.answer).toContain("I can't produce a projected value yet");
    expect(res.answer).not.toMatch(/₹/);
  });
});
