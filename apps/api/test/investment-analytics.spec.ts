import { InvestmentAnalyticsService } from "../src/investments/investment-analytics.service";
import { buildInvestmentSeries, monthWindow } from "../src/investments/investment-analytics.util";

const cf = (investmentId: string, month: string, type: any, total: number) => ({ investmentId, month, type, total });
const val = (investmentId: string, month: string, value: number) => ({ investmentId, month, value });

describe("monthWindow", () => {
  it("returns the last N months oldest-first, across a year boundary", () => {
    expect(monthWindow("2026-02", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthWindow("2026-10", 1)).toEqual(["2026-10"]);
  });
});

describe("buildInvestmentSeries", () => {
  const months = ["2026-08", "2026-09", "2026-10"];

  it("spec Part 58: ₹10,000 contributed then valued at ₹10,500 → the ₹500 is a GAIN, not a contribution", () => {
    const s = buildInvestmentSeries(months, [cf("a", "2026-08", "CONTRIBUTION", 10000)], [val("a", "2026-09", 10500)], "2026-10");
    expect(s.contributionTrend.map((r) => r.contributions.toNumber())).toEqual([10000, 0, 0]); // valuation adds no contribution
    expect(s.valueTrend.map((r) => r.value?.toNumber() ?? null)).toEqual([null, 10500, 10500]); // carried forward
    expect(s.gainTrend.map((r) => r.gain?.toNumber() ?? null)).toEqual([null, 500, 500]);
  });

  it("net invested is cumulative and reduced by money that came back (withdrawals, sales)", () => {
    const s = buildInvestmentSeries(
      months,
      [cf("a", "2026-08", "CONTRIBUTION", 20000), cf("a", "2026-09", "WITHDRAWAL", 5000)],
      [val("a", "2026-08", 21000), val("a", "2026-09", 16500)],
      "2026-10",
    );
    // Aug: 21,000 − 20,000 = +1,000.  Sep: 16,500 − (20,000 − 5,000) = +1,500.
    expect(s.gainTrend.map((r) => r.gain?.toNumber())).toEqual([1000, 1500, 1500]);
    expect(s.contributionTrend[1].withdrawals.toNumber()).toBe(5000);
  });

  it("employer contributions are reported separately from the user's own contributions", () => {
    const s = buildInvestmentSeries(
      months,
      [cf("epf", "2026-09", "CONTRIBUTION", 3000), cf("epf", "2026-09", "EMPLOYER_CONTRIBUTION", 3000)],
      [],
      "2026-10",
    );
    expect(s.contributionTrend[1]).toMatchObject({ month: "2026-09" });
    expect(s.contributionTrend[1].contributions.toNumber()).toBe(3000);
    expect(s.contributionTrend[1].employer.toNumber()).toBe(3000);
    expect(s.contributionsThisMonth.toNumber()).toBe(0);
  });

  it("a holding with a valuation but NO ledger shows in the value trend but never fakes a gain", () => {
    const s = buildInvestmentSeries(months, [], [val("legacy", "2026-08", 50000)], "2026-10");
    expect(s.valueTrend.map((r) => r.value?.toNumber())).toEqual([50000, 50000, 50000]);
    expect(s.gainTrend.every((r) => r.gain === null && r.coveredHoldings === 0)).toBe(true);
    expect(s.holdingsWithLedger).toBe(0);
  });

  it("sums several holdings; a holding only counts once it has a valuation", () => {
    const s = buildInvestmentSeries(
      months,
      [cf("a", "2026-08", "CONTRIBUTION", 1000), cf("b", "2026-08", "CONTRIBUTION", 2000)],
      [val("a", "2026-08", 1100), val("b", "2026-09", 2300)],
      "2026-10",
    );
    expect(s.valueTrend.map((r) => [r.value?.toNumber(), r.holdingsValued])).toEqual([[1100, 1], [3400, 2], [3400, 2]]);
    expect(s.gainTrend.map((r) => [r.gain?.toNumber(), r.coveredHoldings])).toEqual([[100, 1], [400, 2], [400, 2]]);
  });

  it("uses valuations from BEFORE the window as the starting point", () => {
    const s = buildInvestmentSeries(months, [cf("a", "2025-01", "CONTRIBUTION", 10000)], [val("a", "2025-12", 12000)], "2026-10");
    expect(s.valueTrend[0].value?.toNumber()).toBe(12000);
    expect(s.gainTrend[0].gain?.toNumber()).toBe(2000);
  });

  it("this month / this year contributions come from ALL history, not just the chart window", () => {
    const s = buildInvestmentSeries(
      ["2026-09", "2026-10"],
      [
        cf("a", "2026-01", "CONTRIBUTION", 1000),
        cf("a", "2026-09", "CONTRIBUTION", 2000),
        cf("a", "2026-10", "CONTRIBUTION", 500),
        cf("a", "2025-12", "CONTRIBUTION", 99999), // last year: not "this year"
        cf("a", "2026-10", "DIVIDEND", 40), // not a contribution
      ],
      [],
      "2026-10",
    );
    expect(s.contributionsThisMonth.toNumber()).toBe(500);
    expect(s.contributionsThisYear.toNumber()).toBe(3500);
  });

  it("an empty ledger gives a flat, honest series (no NaN, no invented numbers)", () => {
    const s = buildInvestmentSeries(months, [], [], "2026-10");
    expect(s.contributionTrend.map((r) => r.contributions.toNumber())).toEqual([0, 0, 0]);
    expect(s.valueTrend.every((r) => r.value === null && r.holdingsValued === 0)).toBe(true);
  });
});

describe("InvestmentAnalyticsService", () => {
  const NOW = new Date("2026-10-06T10:00:00Z");
  const holding = (over: Record<string, unknown>) => ({
    id: "h", type: "MUTUAL_FUND", riskLevel: "MODERATE", liquidity: "LIQUID", currentValue: 0, sipActive: false, monthlyContribution: null, contributionFrequency: "MONTHLY", contributionStartDate: null, contributionEndDate: null, ...over,
  });
  const build = (cash: unknown[], vals: unknown[], holdings: unknown[]) => {
    const db = { $queryRaw: jest.fn().mockResolvedValueOnce(cash).mockResolvedValueOnce(vals), investment: { findMany: jest.fn().mockResolvedValue(holdings) } };
    return { db, svc: new InvestmentAnalyticsService({ client: db } as never) };
  };

  it("formats the series as money strings and ends with the current month", async () => {
    const { svc } = build([cf("a", "2026-10", "CONTRIBUTION", 10000)], [val("a", "2026-10", 10500)], [holding({ id: "a" })]);
    const out = await svc.analytics("u1", 3, NOW);
    expect(out.basis).toBe("ACTUAL");
    expect(out.months).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(out.contributionTrend[2]).toEqual({ month: "2026-10", contributions: "10000.00", employer: "0.00", withdrawals: "0.00" });
    expect(out.valueTrend[2]).toEqual({ month: "2026-10", value: "10500.00", holdingsValued: 1 });
    expect(out.gainTrend[2]).toEqual({ month: "2026-10", gain: "500.00", coveredHoldings: 1 });
    expect(out.valueTrend[0].value).toBeNull();
  });

  it("planned contributions come only from ACTIVE, un-ended schedules, in monthly and annual equivalents", async () => {
    const { svc } = build([], [], [
      holding({ id: "w", sipActive: true, monthlyContribution: 1000, contributionFrequency: "WEEKLY", contributionStartDate: new Date("2026-01-05") }),
      holding({ id: "m", sipActive: true, monthlyContribution: 10000, contributionFrequency: "MONTHLY", contributionStartDate: new Date("2026-01-05") }),
      holding({ id: "off", sipActive: false, monthlyContribution: 99999, contributionStartDate: new Date("2026-01-05") }),
      holding({ id: "ended", sipActive: true, monthlyContribution: 99999, contributionStartDate: new Date("2024-01-05"), contributionEndDate: new Date("2025-12-31") }),
      holding({ id: "none" }),
    ]);
    const out = await svc.analytics("u1", 3, NOW);
    expect(out.overview).toMatchObject({
      holdings: 5,
      activeSchedules: 2,
      plannedMonthlyContribution: "14333.33", // 4,333.33 weekly-equivalent + 10,000
      plannedAnnualContribution: "172000.00", // 52,000 + 120,000
      actualContributionsThisMonth: "0.00",
    });
  });

  it("reports how many holdings have a ledger so the page can say what the trends are based on", async () => {
    const { svc } = build([cf("a", "2026-09", "CONTRIBUTION", 100)], [], [holding({ id: "a" }), holding({ id: "b" })]);
    const out = await svc.analytics("u1", 2, NOW);
    expect(out.overview).toMatchObject({ holdings: 2, holdingsWithLedger: 1 });
  });

  it("bounds the window (1–36 months) and scopes both queries to the user", async () => {
    const { db, svc } = build([], [], []);
    expect((await svc.analytics("u1", 999, NOW)).months).toHaveLength(36);
    db.$queryRaw.mockResolvedValue([]);
    expect((await svc.analytics("u1", 0, NOW)).months).toHaveLength(1);
    expect(db.investment.findMany.mock.calls[0][0].where).toEqual({ userId: "u1" });
    const sqlValues = (db.$queryRaw.mock.calls[0][0] as { values: unknown[] }).values;
    expect(sqlValues).toContain("u1");
  });

  it("allocation of the current value by type, risk and liquidity, largest first, percent of total", async () => {
    const { svc } = build([], [], [
      holding({ id: "a", type: "MUTUAL_FUND", riskLevel: "HIGH", liquidity: "LIQUID", currentValue: 60000 }),
      holding({ id: "b", type: "PPF", riskLevel: "LOW", liquidity: "ILLIQUID", currentValue: 30000 }),
      holding({ id: "c", type: "MUTUAL_FUND", riskLevel: "LOW", liquidity: "LIQUID", currentValue: 10000 }),
    ]);
    const { allocation } = await svc.analytics("u1", 3, NOW);
    expect(allocation.totalValue).toBe("100000.00");
    expect(allocation.byType).toEqual([
      { key: "MUTUAL_FUND", value: "70000.00", percent: 70 },
      { key: "PPF", value: "30000.00", percent: 30 },
    ]);
    expect(allocation.byRisk).toEqual([
      { key: "LOW", value: "40000.00", percent: 40 },
      { key: "HIGH", value: "60000.00", percent: 60 },
    ].sort((x, y) => y.percent - x.percent));
    expect(allocation.byLiquidity.map((r) => [r.key, r.percent])).toEqual([["LIQUID", 70], ["ILLIQUID", 30]]);
  });

  it("an empty portfolio has an empty allocation, not NaN percentages", async () => {
    const { svc } = build([], [], []);
    const { allocation } = await svc.analytics("u1", 3, NOW);
    expect(allocation).toEqual({ totalValue: "0.00", byType: [], byRisk: [], byLiquidity: [] });
  });
});
