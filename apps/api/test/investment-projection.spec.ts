import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Prisma } from "@wealthos/db";
import { CadenceName, PERIODS_PER_YEAR, projectGrowth } from "../src/common/financial-facts/financial-formulas";
import { InvestmentProjectionService, PROJECTION_DISCLAIMER } from "../src/investments/investment-projection.service";
import { PortfolioProjectionQueryDto, ProjectionQueryDto } from "../src/investments/dto/projection-query.dto";

const D = (n: number | string) => new Prisma.Decimal(n);
const money = (d: Prisma.Decimal) => d.toFixed(2);

// An independent, deliberately naive check: step the pot forward one period at a time in plain floats.
function simulate(current: number, perPeriod: number, cadence: CadenceName, annualPct: number, years: number, contributingPeriods?: number): number {
  const ppy = PERIODS_PER_YEAR[cadence];
  const r = annualPct / 100 / ppy;
  const n = years * ppy;
  const m = Math.min(n, contributingPeriods ?? n);
  let v = current;
  // A SIP is debited at the START of the period, so the contribution earns that period's return.
  for (let i = 1; i <= n; i++) v = (v + (i <= m ? perPeriod : 0)) * (1 + r);
  return v;
}

describe("projectGrowth (deterministic, PROJECTED only)", () => {
  it("spec Part 61: ₹10,000 a month at 12% for 10 years → principal ₹12,00,000, value ₹23,23,391, gain ₹11,23,391", () => {
    const p = projectGrowth({ currentValue: D(0), contributionPerPeriod: D(10000), cadence: "MONTHLY", annualReturnPercent: D(12), years: 10 });
    expect(money(p.totalContributions)).toBe("1200000.00");
    expect(money(p.principal)).toBe("1200000.00");
    expect(money(p.projectedValue)).toBe("2323390.76"); // ₹23,23,391
    expect(money(p.projectedGain)).toBe("1123390.76");
  });

  it("5 / 10 / 15 / 20 / 25 year horizons all follow the same formula and grow with time", () => {
    const at = (years: number) => projectGrowth({ currentValue: D(0), contributionPerPeriod: D(10000), cadence: "MONTHLY", annualReturnPercent: D(12), years });
    expect(money(at(5).projectedValue)).toBe("824863.67");
    expect(money(at(15).projectedValue)).toBe("5045760.00");
    expect(money(at(20).projectedValue)).toBe("9991479.19");
    expect(money(at(25).projectedValue)).toBe("18976350.92");
    const values = [5, 10, 15, 20, 25].map((y) => at(y).projectedValue);
    values.forEach((v, i) => i > 0 && expect(v.gt(values[i - 1])).toBe(true));
    expect(at(5).totalContributions.toNumber()).toBe(600000);
    expect(at(25).totalContributions.toNumber()).toBe(3000000);
  });

  it("changing the return assumption updates the projection (8% < 10% < 12% < 15%)", () => {
    const at = (rate: number) => projectGrowth({ currentValue: D(0), contributionPerPeriod: D(10000), cadence: "MONTHLY", annualReturnPercent: D(rate), years: 10 }).projectedValue;
    const [r8, r10, r12, r15] = [8, 10, 12, 15].map(at);
    expect(r8.lt(r10) && r10.lt(r12) && r12.lt(r15)).toBe(true);
    expect(money(r12)).toBe("2323390.76");
  });

  it("changing the ACTUAL starting value changes the projection but never the contributions put in", () => {
    const base = { contributionPerPeriod: D(10000), cadence: "MONTHLY" as const, annualReturnPercent: D(12), years: 10 };
    const small = projectGrowth({ ...base, currentValue: D(0) });
    const big = projectGrowth({ ...base, currentValue: D(500000) });
    expect(big.projectedValue.gt(small.projectedValue)).toBe(true);
    expect(money(big.totalContributions)).toBe(money(small.totalContributions)); // history/plan unchanged
    expect(money(big.principal)).toBe("1700000.00"); // 5,00,000 today + 12,00,000 contributed
  });

  it("an existing lump sum compounds on its own (₹1,00,000 at 12% monthly for 10 years)", () => {
    const p = projectGrowth({ currentValue: D(100000), contributionPerPeriod: D(0), cadence: "MONTHLY", annualReturnPercent: D(12), years: 10 });
    expect(money(p.projectedValue)).toBe("330038.69");
    expect(money(p.totalContributions)).toBe("0.00");
  });

  it("zero return simply adds up what was put in (no growth, no division by zero)", () => {
    const p = projectGrowth({ currentValue: D(1000), contributionPerPeriod: D(100), cadence: "MONTHLY", annualReturnPercent: D(0), years: 2 });
    expect(money(p.projectedValue)).toBe("3400.00");
    expect(money(p.projectedGain)).toBe("0.00");
  });

  it.each(["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"] as const)("%s agrees with a period-by-period simulation", (cadence) => {
    const p = projectGrowth({ currentValue: D(250000), contributionPerPeriod: D(1500), cadence, annualReturnPercent: D(11.5), years: 12 });
    expect(p.projectedValue.toNumber()).toBeCloseTo(simulate(250000, 1500, cadence, 11.5, 12), 1);
  });

  it("documents the convention: contributions at the START of each period beat the same amounts at the END", () => {
    const start = projectGrowth({ currentValue: D(0), contributionPerPeriod: D(10000), cadence: "MONTHLY", annualReturnPercent: D(12), years: 10 }).projectedValue;
    expect(money(start)).toBe("2323390.76"); // spec: ₹23,23,391
    // End-of-month contributions would be exactly one period of growth lower: 2,323,390.76 / 1.01.
    expect(start.div(1.01).toFixed(2)).toBe("2300386.89");
  });

  it("a schedule that ends contributes only until then, and the pot keeps compounding to the horizon", () => {
    const p = projectGrowth({ currentValue: D(0), contributionPerPeriod: D(10000), cadence: "MONTHLY", annualReturnPercent: D(12), years: 10, contributionPeriods: 24 });
    expect(p.contributionPeriods).toBe(24);
    expect(money(p.totalContributions)).toBe("240000.00");
    expect(money(p.projectedValue)).toBe("708125.11");
    expect(p.projectedValue.toNumber()).toBeCloseTo(simulate(0, 10000, "MONTHLY", 12, 10, 24), 1);
  });

  it("a schedule that has already ended contributes nothing; contributionPeriods is capped at the horizon", () => {
    expect(projectGrowth({ currentValue: D(1000), contributionPerPeriod: D(500), cadence: "MONTHLY", annualReturnPercent: D(10), years: 5, contributionPeriods: 0 }).totalContributions.toNumber()).toBe(0);
    expect(projectGrowth({ currentValue: D(0), contributionPerPeriod: D(500), cadence: "MONTHLY", annualReturnPercent: D(10), years: 1, contributionPeriods: 999 }).contributionPeriods).toBe(12);
  });

  it("is pure: the inputs are never modified (a projection cannot overwrite an actual)", () => {
    const current = D(123456.78);
    const per = D(2500);
    projectGrowth({ currentValue: current, contributionPerPeriod: per, cadence: "BIWEEKLY", annualReturnPercent: D(9), years: 7 });
    expect(current.toString()).toBe("123456.78");
    expect(per.toString()).toBe("2500");
  });
});

describe("InvestmentProjectionService.calculate (the stateless 'what if')", () => {
  const svc = new InvestmentProjectionService({ client: {} } as never);

  it("labels everything PROJECTED, carries the disclaimer, and defaults to 5/10/15/20/25 years", () => {
    const out = svc.calculate({ currentValue: 0, contribution: 10000, annualReturn: 12 } as never);
    expect(out.basis).toBe("PROJECTED");
    expect(out.disclaimer).toBe(PROJECTION_DISCLAIMER);
    expect(out.disclaimer).toMatch(/not a promise/);
    expect(out.scenarios.map((s) => s.years)).toEqual([5, 10, 15, 20, 25]);
    expect(out.scenarios[1]).toMatchObject({ years: 10, totalContributions: "1200000.00", principal: "1200000.00", projectedValue: "2323390.76", projectedGain: "1123390.76" });
    expect(out.assumptions).toEqual({ currentValue: "0.00", contributionPerPeriod: "10000.00", frequency: "MONTHLY", annualReturnPercent: "12" });
  });

  it("returns a yearly growth curve from year 0 to the longest horizon", () => {
    const out = svc.calculate({ currentValue: 50000, contribution: 1000, annualReturn: 10, years: [3, 1] } as never);
    expect(out.curve.map((c) => c.year)).toEqual([0, 1, 2, 3]);
    expect(out.curve[0]).toEqual({ year: 0, principal: "50000.00", projectedValue: "50000.00" });
    expect(out.scenarios.map((s) => s.years)).toEqual([3, 1]); // order requested is preserved here; the DTO sorts it
  });

  it("curve and scenarios agree at every horizon", () => {
    const out = svc.calculate({ contribution: 10000, annualReturn: 12, years: [5, 10] } as never);
    for (const s of out.scenarios) expect(out.curve.find((c) => c.year === s.years)!.projectedValue).toBe(s.projectedValue);
  });

  it("supports every contribution frequency", () => {
    const weekly = svc.calculate({ contribution: 1000, frequency: "WEEKLY", annualReturn: 12, years: [10] } as never);
    expect(weekly.scenarios[0].totalContributions).toBe("520000.00"); // 52 × 10 × 1,000
    const yearly = svc.calculate({ contribution: 50000, frequency: "YEARLY", annualReturn: 12, years: [10] } as never);
    expect(yearly.scenarios[0].totalContributions).toBe("500000.00");
  });
});

describe("projection query validation", () => {
  const check = async (cls: any, plain: Record<string, unknown>) => {
    const inst = plainToInstance(cls, plain);
    return { inst: inst as any, errors: await validate(inst as object) };
  };

  it("requires an explicit return assumption — it is never a hidden default", async () => {
    const { errors } = await check(ProjectionQueryDto, { contribution: "1000" });
    expect(errors.some((e) => e.property === "annualReturn")).toBe(true);
  });

  it("parses query strings: numbers, and a comma list of years that is sorted and de-duplicated", async () => {
    const { inst, errors } = await check(ProjectionQueryDto, { annualReturn: "12", currentValue: "5000", contribution: "1000", years: "10,5,5,25" });
    expect(errors).toEqual([]);
    expect(inst.annualReturn).toBe(12);
    expect(inst.years).toEqual([5, 10, 25]);
  });

  it.each([
    ["a zero horizon", { annualReturn: "10", years: "0" }],
    ["a 60-year horizon", { annualReturn: "10", years: "60" }],
    ["a fractional horizon", { annualReturn: "10", years: "2.5" }],
    ["more than 8 horizons", { annualReturn: "10", years: "1,2,3,4,5,6,7,8,9" }],
    ["a negative return", { annualReturn: "-1" }],
    ["an absurd return", { annualReturn: "400" }],
    ["a negative contribution", { annualReturn: "10", contribution: "-5" }],
    ["an unknown frequency", { annualReturn: "10", frequency: "DAILY" }],
  ])("rejects %s", async (_n, plain) => {
    expect((await check(ProjectionQueryDto, plain)).errors.length).toBeGreaterThan(0);
  });

  it("the portfolio query's default return is optional but bounded", async () => {
    expect((await check(PortfolioProjectionQueryDto, {})).errors).toEqual([]);
    expect((await check(PortfolioProjectionQueryDto, { annualReturn: "12", years: "5,10" })).errors).toEqual([]);
    expect((await check(PortfolioProjectionQueryDto, { annualReturn: "500" })).errors.length).toBeGreaterThan(0);
  });
});

describe("InvestmentProjectionService.portfolio (the user's actual holdings)", () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const ASOF = d("2026-10-06");

  const holding = (over: Record<string, unknown>) => ({
    id: "h", name: "Fund", type: "MUTUAL_FUND", currentValue: 100000, sipActive: false, monthlyContribution: null, contributionDay: null,
    contributionFrequency: "MONTHLY", contributionStartDate: null, contributionEndDate: null, expectedAnnualReturn: null, ...over,
  });
  const build = (rows: unknown[]) => {
    const db = { investment: { findMany: jest.fn().mockResolvedValue(rows) } };
    return { db, svc: new InvestmentProjectionService({ client: db } as never) };
  };

  it("uses each holding's own assumption, falls back to the caller's default, and EXCLUDES holdings with neither", async () => {
    const { svc } = build([
      holding({ id: "a", name: "Own rate", currentValue: 100000, expectedAnnualReturn: 10 }),
      holding({ id: "b", name: "Default rate", currentValue: 50000 }),
      holding({ id: "c", name: "No rate", currentValue: 30000 }),
    ]);

    const withDefault = await svc.portfolio("u1", { annualReturn: 8, years: [10] } as never, ASOF);
    expect(withDefault.holdings.map((h) => [h.id, h.rateSource, h.annualReturnPercent, h.included])).toEqual([
      ["a", "INVESTMENT", "10", true],
      ["b", "DEFAULT", "8", true],
      ["c", "DEFAULT", "8", true],
    ]);

    const noDefault = await svc.portfolio("u1", { years: [10] } as never, ASOF);
    expect(noDefault.holdings.map((h) => [h.id, h.rateSource, h.included])).toEqual([["a", "INVESTMENT", true], ["b", "NONE", false], ["c", "NONE", false]]);
    expect(noDefault).toMatchObject({ includedCount: 1, excludedCount: 2, defaultAnnualReturnPercent: null });
    // The ACTUAL value still counts every holding; only the projection skips the ones with no assumption.
    expect(noDefault.actual).toEqual({ basis: "ACTUAL", currentValue: "180000.00", holdings: 3 });
    expect(noDefault.includedValueToday).toBe("100000.00");
  });

  it("the projection is the sum of the per-holding projections (no page-specific maths)", async () => {
    const { svc } = build([holding({ id: "a", currentValue: 100000, expectedAnnualReturn: 10 }), holding({ id: "b", currentValue: 50000, expectedAnnualReturn: 6 })]);
    const out = await svc.portfolio("u1", { years: [10] } as never, ASOF);
    const expected = (v: number, r: number) => projectGrowth({ currentValue: D(v), contributionPerPeriod: D(0), cadence: "MONTHLY", annualReturnPercent: D(r), years: 10 }).projectedValue;
    expect(out.scenarios[0].projectedValue).toBe(money(expected(100000, 10).plus(expected(50000, 6))));
    expect(out.basis).toBe("PROJECTED");
    expect(out.disclaimer).toBe(PROJECTION_DISCLAIMER);
  });

  it("includes an ACTIVE schedule's contributions at its own cadence", async () => {
    const { svc } = build([
      holding({ id: "a", currentValue: 0, expectedAnnualReturn: 12, sipActive: true, monthlyContribution: 10000, contributionFrequency: "MONTHLY", contributionStartDate: d("2026-01-05"), contributionDay: 5 }),
    ]);
    const out = await svc.portfolio("u1", { years: [10] } as never, ASOF);
    expect(out.scenarios[0]).toMatchObject({ totalContributions: "1200000.00", projectedValue: "2323390.76" });
    expect(out.holdings[0]).toMatchObject({ contributionPerPeriod: "10000.00", frequency: "MONTHLY" });
  });

  it("an inactive schedule contributes nothing", async () => {
    const { svc } = build([holding({ expectedAnnualReturn: 12, sipActive: false, monthlyContribution: 10000, contributionStartDate: d("2026-01-05") })]);
    const out = await svc.portfolio("u1", { years: [5] } as never, ASOF);
    expect(out.scenarios[0].totalContributions).toBe("0.00");
    expect(out.holdings[0].contributionPerPeriod).toBeNull();
  });

  it("a schedule with an end date only contributes for the periods still to come", async () => {
    const { svc } = build([
      holding({ currentValue: 0, expectedAnnualReturn: 12, sipActive: true, monthlyContribution: 10000, contributionFrequency: "MONTHLY", contributionStartDate: d("2026-01-05"), contributionDay: 5, contributionEndDate: d("2027-10-05") }),
    ]);
    const out = await svc.portfolio("u1", { years: [10] } as never, ASOF);
    // After 6 Oct 2026: 5 Nov 2026 … 5 Oct 2027 = 12 remaining contributions.
    expect(out.scenarios[0].totalContributions).toBe("120000.00");
  });

  it("a schedule that already ended contributes nothing more", async () => {
    const { svc } = build([
      holding({ currentValue: 100000, expectedAnnualReturn: 10, sipActive: true, monthlyContribution: 10000, contributionFrequency: "MONTHLY", contributionStartDate: d("2024-01-05"), contributionDay: 5, contributionEndDate: d("2025-12-05") }),
    ]);
    const out = await svc.portfolio("u1", { years: [5] } as never, ASOF);
    expect(out.scenarios[0].totalContributions).toBe("0.00");
  });

  it("returns no scenarios (not zeros) when nothing can be projected", async () => {
    const { svc } = build([holding({ currentValue: 5000 })]);
    const out = await svc.portfolio("u1", {} as never, ASOF);
    expect(out).toMatchObject({ scenarios: [], curve: [], includedCount: 0, excludedCount: 1 });
  });

  it("only ever reads the caller's holdings", async () => {
    const { db, svc } = build([]);
    await svc.portfolio("u1", {} as never, ASOF);
    expect(db.investment.findMany.mock.calls[0][0].where).toEqual({ userId: "u1" });
  });
});
