jest.mock("../src/common/financial-facts/financial-facts.service", () => ({ FinancialFactsService: class {} }));

import { Prisma } from "@wealthos/db";
import { InvestmentLedgerService } from "../src/investments/investment-ledger.service";
import {
  SipSchedule,
  countSipOccurrences,
  dueSipPeriods,
  maxPeriodsPerRun,
  nextSipOccurrence,
  sipPeriodKeyFor,
} from "../src/investments/investment-sip.util";
import { annualContribution, monthlyEquivalent } from "../src/common/financial-facts/financial-formulas";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const D = (n: number | string) => new Prisma.Decimal(n);

describe("SIP schedule — every frequency (spec Part 13 / 16)", () => {
  const base = (over: Partial<SipSchedule>): SipSchedule => ({ contributionDay: 5, startDate: d("2026-09-01"), endDate: null, ...over });

  it("MONTHLY is unchanged: 'YYYY-MM' keys on the contribution day, clamped to month end", () => {
    const due = dueSipPeriods(base({ startDate: d("2026-01-31"), contributionDay: 31 }), d("2026-03-31"));
    expect(due.map((p) => [p.periodKey, iso(p.occurredAt)])).toEqual([
      ["2026-01", "2026-01-31"],
      ["2026-02", "2026-02-28"],
      ["2026-03", "2026-03-31"],
    ]);
  });

  it("WEEKLY: every 7 days from the start date, keyed by the date, one per period", () => {
    const due = dueSipPeriods(base({ frequency: "WEEKLY", startDate: d("2026-09-07") }), d("2026-09-30"));
    expect(due.map((p) => p.periodKey)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
  });

  it("BIWEEKLY: every 14 days from the start date", () => {
    const due = dueSipPeriods(base({ frequency: "BIWEEKLY", startDate: d("2026-09-07") }), d("2026-10-31"));
    expect(due.map((p) => p.periodKey)).toEqual(["2026-09-07", "2026-09-21", "2026-10-05", "2026-10-19"]);
  });

  it("QUARTERLY: every 3 months on the contribution day, keyed by quarter", () => {
    const due = dueSipPeriods(base({ frequency: "QUARTERLY", startDate: d("2026-01-05") }), d("2026-12-31"));
    expect(due.map((p) => [p.periodKey, iso(p.occurredAt)])).toEqual([
      ["2026-Q1", "2026-01-05"],
      ["2026-Q2", "2026-04-05"],
      ["2026-Q3", "2026-07-05"],
      ["2026-Q4", "2026-10-05"],
    ]);
  });

  it("YEARLY: once a year, keyed by year", () => {
    const due = dueSipPeriods(base({ frequency: "YEARLY", startDate: d("2024-03-05") }), d("2026-12-31"));
    expect(due.map((p) => p.periodKey)).toEqual(["2024", "2025", "2026"]);
  });

  it("never schedules a contribution in the future (a forecast must not become an actual)", () => {
    expect(dueSipPeriods(base({ frequency: "WEEKLY", startDate: d("2026-10-10") }), d("2026-10-09"))).toEqual([]);
    expect(dueSipPeriods(base({ frequency: "BIWEEKLY", startDate: d("2026-09-07") }), d("2026-09-20")).map((p) => p.periodKey)).toEqual(["2026-09-07"]);
  });

  it("stops at the end date for every frequency", () => {
    const due = dueSipPeriods(base({ frequency: "WEEKLY", startDate: d("2026-09-07"), endDate: d("2026-09-20") }), d("2026-12-31"));
    expect(due.map((p) => p.periodKey)).toEqual(["2026-09-07", "2026-09-14"]);
  });

  it("period keys: monthly keeps its format; weekly/biweekly use the date", () => {
    expect(sipPeriodKeyFor("MONTHLY", d("2026-09-14"))).toBe("2026-09");
    expect(sipPeriodKeyFor("WEEKLY", d("2026-09-14"))).toBe("2026-09-14");
    expect(sipPeriodKeyFor("BIWEEKLY", d("2026-09-14"))).toBe("2026-09-14");
    expect(sipPeriodKeyFor("QUARTERLY", d("2026-11-01"))).toBe("2026-Q4");
    expect(sipPeriodKeyFor("YEARLY", d("2026-11-01"))).toBe("2026");
  });

  it("next contribution: the first scheduled date on/after today, or null once finished", () => {
    const weekly = base({ frequency: "WEEKLY", startDate: d("2026-09-07") });
    expect(iso(nextSipOccurrence(weekly, d("2026-10-06"))!)).toBe("2026-10-12");
    expect(iso(nextSipOccurrence(weekly, d("2026-10-05"))!)).toBe("2026-10-05"); // today counts
    expect(nextSipOccurrence({ ...weekly, endDate: d("2026-09-20") }, d("2026-10-06"))).toBeNull();
    expect(iso(nextSipOccurrence(base({ startDate: d("2026-09-01"), contributionDay: 5 }), d("2026-10-06"))!)).toBe("2026-11-05");
  });

  it("counts scheduled dates up to a date (planned / due-so-far / remaining)", () => {
    const s = base({ frequency: "BIWEEKLY", startDate: d("2026-01-02"), endDate: d("2026-12-31") });
    expect(countSipOccurrences(s, d("2026-12-31"))).toBe(26);
  });

  describe("long schedules resume after the latest generated period (the per-run cap bug)", () => {
    const longMonthly = base({ startDate: d("2018-01-01"), contributionDay: 1 }); // ~100 months of history

    it("without a cursor the cap selects the OLDEST periods (documents why a cursor is needed)", () => {
      const due = dueSipPeriods(longMonthly, d("2026-10-31"));
      expect(due).toHaveLength(maxPeriodsPerRun("MONTHLY"));
      expect(due[0].periodKey).toBe("2018-01");
    });

    it("with a cursor a capped run continues AFTER what already exists, so the newest periods get created", () => {
      const due = dueSipPeriods(longMonthly, d("2026-10-31"), { after: d("2022-12-01") });
      expect(due[0].periodKey).toBe("2023-01");
      expect(due.length).toBeLessThanOrEqual(maxPeriodsPerRun("MONTHLY"));
    });

    it("a short schedule ignores the cursor and still fills any gap, exactly as before", () => {
      const short = base({ startDate: d("2026-01-01"), contributionDay: 1 });
      const due = dueSipPeriods(short, d("2026-04-30"), { after: d("2026-03-01") });
      expect(due.map((p) => p.periodKey)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    });
  });
});

describe("contribution equivalents (one canonical formula)", () => {
  it("annual = amount × periods per year; monthly equivalent = annual / 12", () => {
    expect(annualContribution(D(1000), "WEEKLY").toFixed(2)).toBe("52000.00");
    expect(monthlyEquivalent(D(1000), "WEEKLY").toFixed(2)).toBe("4333.33");
    expect(annualContribution(D(1000), "BIWEEKLY").toFixed(2)).toBe("26000.00");
    expect(monthlyEquivalent(D(1000), "BIWEEKLY").toFixed(2)).toBe("2166.67");
    expect(monthlyEquivalent(D(10000), "MONTHLY").toFixed(2)).toBe("10000.00");
    expect(annualContribution(D(30000), "QUARTERLY").toFixed(2)).toBe("120000.00");
    expect(monthlyEquivalent(D(120000), "YEARLY").toFixed(2)).toBe("10000.00");
  });
});

// ---------------------------------------------------------------------------------------
// The ledger service against an in-memory investment + cashflow store.
// ---------------------------------------------------------------------------------------
type Row = Record<string, any>;

function build(inv: Row) {
  const investment = { id: "i1", userId: "u1", type: "MUTUAL_FUND", monthlyContribution: null, contributionDay: null, contributionFrequency: "MONTHLY", contributionStartDate: null, contributionEndDate: null, sipActive: false, expectedAnnualReturn: null, ...inv };
  const cashflows: Row[] = [];
  const db: any = {
    investment: {
      findFirst: jest.fn(async () => investment),
      update: jest.fn(async ({ data }: any) => Object.assign(investment, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)))),
      findMany: jest.fn(async () => [investment]),
    },
    investmentCashflow: {
      aggregate: jest.fn(async ({ where }: any) => {
        const rows = cashflows.filter((r) => r.type === where.type && (!where.origin || r.origin === where.origin));
        return {
          _max: { occurredAt: rows.length ? new Date(Math.max(...rows.map((r) => r.occurredAt.getTime()))) : null },
          _sum: { amount: rows.length ? rows.reduce((a, r) => a + Number(r.amount), 0) : null },
          _count: { _all: rows.length },
        };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        cashflows.filter((r) => {
          if (where.periodKey === null) return r.periodKey === null && r.occurredAt >= where.occurredAt.gte;
          return where.periodKey.in.includes(r.periodKey);
        }),
      ),
      create: jest.fn(async ({ data }: any) => {
        if (cashflows.some((r) => r.periodKey && r.periodKey === data.periodKey && r.type === data.type)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        cashflows.push({ id: `cf${cashflows.length + 1}`, ...data });
        return data;
      }),
    },
  };
  return { db, investment, cashflows, svc: new InvestmentLedgerService({ client: db } as never, {} as never) };
}

describe("InvestmentLedgerService — contribution schedules", () => {
  it("setSipSchedule defaults to MONTHLY on the start date's day (what existing clients get)", async () => {
    const { investment, svc } = build({});
    await svc.setSipSchedule("u1", "i1", { monthlyContribution: 10000, startDate: "2026-09-15", active: true, confirmBackfill: true } as never);
    expect(investment).toMatchObject({ contributionFrequency: "MONTHLY", contributionDay: 15, monthlyContribution: 10000, sipActive: true });
  });

  it("a weekly schedule has no day of month and stores the expected return as an assumption only", async () => {
    const { investment, svc } = build({});
    await svc.setSipSchedule("u1", "i1", { monthlyContribution: 1000, frequency: "WEEKLY", startDate: "2026-09-07", active: true, confirmBackfill: true, expectedAnnualReturn: 12 } as never);
    expect(investment).toMatchObject({ contributionFrequency: "WEEKLY", contributionDay: null, expectedAnnualReturn: 12 });
  });

  it("leaves a previously saved expected return alone when an update doesn't send one", async () => {
    const { investment, svc } = build({ expectedAnnualReturn: 10 });
    await svc.setSipSchedule("u1", "i1", { monthlyContribution: 2000, startDate: "2026-09-15", active: true, confirmBackfill: true } as never);
    expect(investment.expectedAnnualReturn).toBe(10);
  });

  it("the past-start backfill confirmation applies to every frequency (past contributions become actuals)", async () => {
    const { investment, svc } = build({});
    await expect(
      svc.setSipSchedule("u1", "i1", { monthlyContribution: 1000, frequency: "BIWEEKLY", startDate: "2020-01-06", active: true } as never),
    ).rejects.toThrow(/confirmBackfill/);
    expect(investment.sipActive).toBe(false);
  });

  it("generates one contribution per weekly period and is idempotent on re-runs and retries", async () => {
    const { cashflows, svc } = build({
      sipActive: true, monthlyContribution: 1000, contributionFrequency: "WEEKLY", contributionStartDate: d("2026-09-07"), contributionEndDate: null,
    });
    const first = await svc.generateSipContributions("u1", "i1", d("2026-09-30"));
    expect(first.created).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
    expect(cashflows.every((r) => r.origin === "RECURRING" && Number(r.amount) === 1000)).toBe(true);

    const again = await svc.generateSipContributions("u1", "i1", d("2026-09-30"));
    expect(again.created).toEqual([]);
    expect(again.alreadyExisted).toHaveLength(4);
    expect(cashflows).toHaveLength(4); // retries add nothing

    const later = await svc.generateSipContributions("u1", "i1", d("2026-10-06"));
    expect(later.created).toEqual(["2026-10-05"]); // only the newly due period
    expect(cashflows).toHaveLength(5);
  });

  it("a manual contribution blocks ONLY its own period: a weekly SIP is not suppressed for the whole month", async () => {
    const { cashflows, svc } = build({
      sipActive: true, monthlyContribution: 1000, contributionFrequency: "WEEKLY", contributionStartDate: d("2026-09-07"), contributionEndDate: null,
    });
    cashflows.push({ id: "manual", type: "CONTRIBUTION", periodKey: null, origin: "MANUAL", amount: 1000, occurredAt: d("2026-09-14") });
    const out = await svc.generateSipContributions("u1", "i1", d("2026-09-30"));
    expect(out.created).toEqual(["2026-09-07", "2026-09-21", "2026-09-28"]);
    expect(out.alreadyExisted).toEqual(["2026-09-14"]); // that one period is left for the user to decide
  });

  it("a monthly SIP is still blocked for the whole month by a manual contribution (unchanged behaviour)", async () => {
    const { cashflows, svc } = build({
      sipActive: true, monthlyContribution: 10000, contributionDay: 5, contributionFrequency: "MONTHLY", contributionStartDate: d("2026-09-05"), contributionEndDate: null,
    });
    cashflows.push({ id: "manual", type: "CONTRIBUTION", periodKey: null, origin: "MANUAL", amount: 10000, occurredAt: d("2026-09-20") });
    const out = await svc.generateSipContributions("u1", "i1", d("2026-10-31"));
    expect(out.created).toEqual(["2026-10"]);
    expect(out.alreadyExisted).toEqual(["2026-09"]);
  });

  it("a schedule longer than the per-run cap resumes after what exists, so today's contributions are not starved", async () => {
    const { cashflows, svc } = build({
      sipActive: true, monthlyContribution: 5000, contributionDay: 1, contributionFrequency: "MONTHLY", contributionStartDate: d("2018-01-01"), contributionEndDate: null,
    });
    const first = await svc.generateSipContributions("u1", "i1", d("2026-10-31"));
    expect(first.created).toHaveLength(60); // the cap: the OLDEST 60 periods (2018-01 … 2022-12)
    const second = await svc.generateSipContributions("u1", "i1", d("2026-10-31"));
    expect(second.created[0]).toBe("2023-01"); // resumes after the latest generated period…
    expect(second.created.at(-1)).toBe("2026-10"); // …and reaches the newest one (46 periods remained)
    const third = await svc.generateSipContributions("u1", "i1", d("2026-10-31"));
    expect(third.created).toEqual([]);
    expect(cashflows).toHaveLength(106); // Jan 2018 … Oct 2026, one each
    expect(new Set(cashflows.map((r) => r.periodKey)).size).toBe(cashflows.length); // never a duplicate
  });

  it("an inactive schedule generates nothing", async () => {
    const { cashflows, svc } = build({ sipActive: false, monthlyContribution: 1000, contributionFrequency: "WEEKLY", contributionStartDate: d("2026-09-07") });
    expect((await svc.generateSipContributions("u1", "i1", d("2026-10-31"))).created).toEqual([]);
    expect(cashflows).toHaveLength(0);
  });

  describe("getSipSchedule summary", () => {
    it("weekly ₹1,000: monthly equivalent, annual contribution, next date, planned vs due vs remaining, actuals", async () => {
      const { cashflows, svc } = build({
        sipActive: true, monthlyContribution: 1000, contributionFrequency: "WEEKLY", contributionStartDate: d("2026-09-07"), contributionEndDate: d("2026-12-28"),
      });
      await svc.generateSipContributions("u1", "i1", d("2026-10-06"));
      expect(cashflows).toHaveLength(5); // 7, 14, 21, 28 Sep and 5 Oct

      const s = await svc.getSipSchedule("u1", "i1", d("2026-10-06"));
      expect(s).toMatchObject({
        frequency: "WEEKLY",
        amountPerPeriod: "1000.00",
        monthlyEquivalent: "4333.33",
        annualContribution: "52000.00",
        nextContributionDate: d("2026-10-12").toISOString(),
        dueSoFarCount: 5,
        plannedCount: 17, // 7 Sep … 28 Dec, every 7 days
        remainingCount: 12,
        plannedTotal: "17000.00",
        actualCount: 5,
        actualAmount: "5000.00",
      });
    });

    it("an open-ended schedule has no planned total or remaining count", async () => {
      const { svc } = build({ sipActive: true, monthlyContribution: 10000, contributionDay: 5, contributionFrequency: "MONTHLY", contributionStartDate: d("2026-09-05") });
      const s = await svc.getSipSchedule("u1", "i1", d("2026-10-06"));
      expect(s).toMatchObject({ frequency: "MONTHLY", monthlyEquivalent: "10000.00", annualContribution: "120000.00", plannedCount: null, remainingCount: null, plannedTotal: null, nextContributionDate: d("2026-11-05").toISOString() });
    });

    it("an inactive schedule has no next contribution; no schedule at all is an empty summary", async () => {
      const inactive = build({ sipActive: false, monthlyContribution: 1000, contributionFrequency: "BIWEEKLY", contributionStartDate: d("2026-09-07") });
      expect((await inactive.svc.getSipSchedule("u1", "i1", d("2026-10-06"))).nextContributionDate).toBeNull();
      const none = build({});
      expect(await none.svc.getSipSchedule("u1", "i1", d("2026-10-06"))).toMatchObject({ active: false, amountPerPeriod: null, monthlyEquivalent: null, actualCount: 0 });
    });
  });
});
