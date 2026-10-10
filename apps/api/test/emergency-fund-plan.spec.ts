jest.mock("../src/common/financial-facts/financial-facts.service", () => ({ FinancialFactsService: class {} }));

import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { EmergencyFundService } from "../src/financial-core/emergency-fund/emergency-fund.service";
import { buildLedger, buildTrend, summarizeLedger } from "../src/financial-core/emergency-fund/emergency-fund.util";
import { emergencyRemaining, emergencyReserveDelta, emergencyTargetFromMonths, periodsToReach, periodsUntil, requiredContribution } from "../src/common/financial-facts/financial-formulas";

const D = (n: number | string) => new Prisma.Decimal(n);
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = d("2026-10-06");

describe("emergency target & plan formulas", () => {
  it("spec Part 21: ₹25,000 essential × 6 months = ₹1,50,000; with ₹82,000 → remaining ₹68,000", () => {
    const target = emergencyTargetFromMonths(D(6), D(25000))!;
    expect(target.toFixed(2)).toBe("150000.00");
    expect(emergencyRemaining(target, D(82000)).toFixed(2)).toBe("68000.00");
  });

  it("a months target needs spending history: no baseline → no rupee target (never 0)", () => {
    expect(emergencyTargetFromMonths(D(6), D(0))).toBeNull();
  });

  it("nothing remains once the target is met (never negative)", () => {
    expect(emergencyRemaining(D(100000), D(120000)).toFixed(2)).toBe("0.00");
  });

  it("periods until a date round UP (a plan never assumes the money arrives after the deadline)", () => {
    expect(periodsUntil(d("2027-04-03"), NOW, 30.4375)).toBe(6); // 179 days = 5.88 months
    expect(periodsUntil(d("2026-10-13"), NOW, 7)).toBe(1);
    expect(periodsUntil(d("2026-10-14"), NOW, 7)).toBe(2);
    expect(periodsUntil(NOW, NOW, 30.4375)).toBe(0); // today
    expect(periodsUntil(d("2026-01-01"), NOW, 30.4375)).toBe(0); // already past
  });

  it("required contribution = remaining / periods; zero when nothing remains; null with no time left", () => {
    expect(requiredContribution(D(68000), 6)!.toFixed(2)).toBe("11333.33");
    expect(requiredContribution(D(0), 0)!.toFixed(2)).toBe("0.00");
    expect(requiredContribution(D(68000), 0)).toBeNull();
  });

  it("periods to reach at a planned contribution (rounded up); null when nothing is contributed", () => {
    expect(periodsToReach(D(68000), D(10000))).toBe(7);
    expect(periodsToReach(D(68000), D(0))).toBeNull();
    expect(periodsToReach(D(0), D(0))).toBe(0);
  });
});

describe("emergency ledger util", () => {
  const e = (id: string, type: any, amount: number, iso: string, createdAt = 0) => ({ id, type, amount, occurredAt: d(iso), createdAt: new Date(createdAt) });

  it("each row shows the balance AFTER it, newest first", () => {
    const rows = buildLedger([e("a", "ALLOCATE", 7000, "2026-09-01"), e("b", "WITHDRAWAL", 3000, "2026-09-10"), e("c", "ALLOCATE", 2000, "2026-10-01")]);
    expect(rows.map((r) => [r.id, r.balanceAfter.toNumber(), r.effect.toNumber()])).toEqual([["c", 6000, 2000], ["b", 4000, -3000], ["a", 7000, 7000]]);
  });

  it("entries on the same day run in the order they were made", () => {
    const rows = buildLedger([e("later", "WITHDRAWAL", 500, "2026-09-01", 2), e("first", "ALLOCATE", 1000, "2026-09-01", 1)]);
    expect(rows.map((r) => [r.id, r.balanceAfter.toNumber()])).toEqual([["later", 500], ["first", 1000]]);
  });

  it("every entry's effect is the canonical reserve delta (so it matches the balance everywhere else)", () => {
    const entries = [e("1", "ALLOCATE", 100, "2026-01-01"), e("2", "TRANSFER_IN", 50, "2026-01-02"), e("3", "RELEASE", 30, "2026-01-03"), e("4", "TRANSFER_OUT", 20, "2026-01-04"), e("5", "ADJUSTMENT", -10, "2026-01-05")];
    const rows = buildLedger(entries);
    entries.forEach((en) => expect(rows.find((r) => r.id === en.id)!.effect.toString()).toBe(emergencyReserveDelta({ type: en.type, amount: en.amount }).toString()));
    expect(rows[0].balanceAfter.toNumber()).toBe(90);
  });

  it("trend: month-end balance carried through quiet months, with what was added and used", () => {
    const t = buildTrend([e("a", "ALLOCATE", 7000, "2026-08-10"), e("b", "WITHDRAWAL", 3000, "2026-10-02")], ["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(t.map((p) => [p.month, p.closingBalance.toNumber(), p.added.toNumber(), p.used.toNumber()])).toEqual([
      ["2026-07", 0, 0, 0],
      ["2026-08", 7000, 7000, 0],
      ["2026-09", 7000, 0, 0],
      ["2026-10", 4000, 0, 3000],
    ]);
  });

  it("totals keep contributions, withdrawals and adjustments apart", () => {
    const t = summarizeLedger(
      [e("a", "ALLOCATE", 5000, "2026-01-05"), e("b", "ALLOCATE", 2000, "2026-10-01"), e("c", "WITHDRAWAL", 1500, "2026-10-03"), e("d", "ADJUSTMENT", 250, "2026-10-04"), e("old", "ALLOCATE", 999, "2025-12-31")],
      "2026-10",
    );
    expect(t.balance.toNumber()).toBe(5000 + 2000 - 1500 + 250 + 999);
    expect(t.contributions.toNumber()).toBe(5000 + 2000 + 999);
    expect(t.withdrawals.toNumber()).toBe(1500);
    expect(t.adjustments.toNumber()).toBe(250); // a correction never inflates "contributions"
    expect(t.contributionsThisMonth.toNumber()).toBe(2000);
    expect(t.contributionsThisYear.toNumber()).toBe(7000); // 2025's 999 is not this year
    expect(t.withdrawalsThisYear.toNumber()).toBe(1500);
    expect(t.lastContribution?.amount.toNumber()).toBe(2000);
    expect(t.lastWithdrawal?.amount.toNumber()).toBe(1500);
  });

  it("an empty ledger is all zeros with no 'last' activity", () => {
    const t = summarizeLedger([], "2026-10");
    expect(t.balance.toNumber()).toBe(0);
    expect(t.lastContribution).toBeNull();
    expect(t.lastWithdrawal).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// The service against an in-memory store.
// ---------------------------------------------------------------------------------------
type Row = Record<string, any>;

function build(opts: { entries?: Row[]; plan?: Row | null; avgEssential?: number; categoryType?: string | null } = {}) {
  const entries: Row[] = (opts.entries ?? []).map((r, i) => ({ userId: "u1", createdAt: new Date(i), ...r }));
  const expenses: Row[] = [];
  let plan: Row | null = opts.plan ?? null;
  const balanceOf = () => entries.reduce((a, r) => a.plus(emergencyReserveDelta({ type: r.type, amount: r.amount })), D(0));

  const db: any = {
    emergencyFundEntry: {
      findMany: jest.fn(async () => [...entries]),
      findFirst: jest.fn(async ({ where }: any) => entries.find((r) => r.id === where.id && r.userId === where.userId) ?? null),
      create: jest.fn(async ({ data }: any) => { const row = { id: `n${entries.length + 1}`, createdAt: new Date(1000 + entries.length), ...data }; entries.push(row); return row; }),
      deleteMany: jest.fn(async ({ where }: any) => { const i = entries.findIndex((r) => r.id === where.id); if (i >= 0) entries.splice(i, 1); return { count: i >= 0 ? 1 : 0 }; }),
      groupBy: jest.fn(async () => {
        const by = new Map<string, number>();
        for (const r of entries) by.set(r.type, (by.get(r.type) ?? 0) + Number(r.amount));
        return [...by.entries()].map(([type, amount]) => ({ type, _sum: { amount } }));
      }),
    },
    emergencyFundPlan: {
      findUnique: jest.fn(async () => plan),
      upsert: jest.fn(async ({ create, update }: any) => { plan = plan ? { ...plan, ...update } : { id: "p1", ...create }; return plan; }),
    },
    category: { findUnique: jest.fn(async () => (opts.categoryType === null ? null : { type: opts.categoryType ?? "NEED", name: "Medical" })) },
    expense: { create: jest.fn(async ({ data }: any) => { const row = { id: `x${expenses.length + 1}`, ...data }; expenses.push(row); return row; }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(db));

  const avg = opts.avgEssential ?? 25000;
  const facts = {
    // The real facts service derives these from the same ledger; the fake mirrors that.
    getEmergencyCoverage: jest.fn(async () => ({
      emergencyCash: balanceOf().toFixed(2),
      avgMonthlyEssentialExpenses: D(avg).toFixed(2),
      coverageMonths: avg > 0 ? balanceOf().div(avg).toFixed(2) : null,
      monthsOfData: avg > 0 ? 3 : 0,
    })),
  };
  return { db, entries, expenses, getPlan: () => plan, svc: new EmergencyFundService({ client: db } as never, facts as never) };
}

const alloc = (amount: number, iso = "2026-09-01", id = `a${amount}${iso}`) => ({ id, type: "ALLOCATE", amount, occurredAt: d(iso) });

describe("EmergencyFundService.overview (spec Parts 20–22)", () => {
  it("Part 21: ₹82,000 in the fund, target 6 months of ₹25,000 → target ₹1,50,000, remaining ₹68,000, 54.7%, coverage 3.28 months", async () => {
    const { svc } = build({ entries: [alloc(82000)], plan: { targetMonths: 6, targetAmount: null } });
    const o = await svc.overview("u1", NOW);
    expect(o).toMatchObject({
      basis: "ACTUAL",
      balance: "82000.00",
      coverage: { months: "3.28", avgMonthlyEssentialExpenses: "25000.00" },
      target: { basis: "TARGET", mode: "MONTHS", amount: "150000.00", months: "6", needsExpenseHistory: false },
      progress: { percent: 54.7, remaining: "68000.00", reached: false },
    });
  });

  it("a fixed-amount target works the same way, and 'reached' is explicit", async () => {
    const { svc } = build({ entries: [alloc(120000)], plan: { targetAmount: 100000, targetMonths: null } });
    const o = await svc.overview("u1", NOW);
    expect(o.target).toMatchObject({ mode: "AMOUNT", amount: "100000.00" });
    expect(o.progress).toEqual({ percent: 120, remaining: "0.00", reached: true });
    expect(o.plan.requiredMonthly).toBeNull(); // no target date set
  });

  it("with no target set there is no progress, and nothing is invented", async () => {
    const { svc } = build({ entries: [alloc(5000)] });
    const o = await svc.overview("u1", NOW);
    expect(o.target).toMatchObject({ mode: null, amount: null });
    expect(o.progress).toEqual({ percent: null, remaining: null, reached: false });
    expect(o.balance).toBe("5000.00");
  });

  it("a months target with no spending history says so instead of showing ₹0", async () => {
    const { svc } = build({ entries: [alloc(5000)], plan: { targetMonths: 6 }, avgEssential: 0 });
    const o = await svc.overview("u1", NOW);
    expect(o.target).toMatchObject({ mode: "MONTHS", amount: null, needsExpenseHistory: true });
    expect(o.coverage.months).toBeNull();
    expect(o.progress.percent).toBeNull();
  });

  it("contribution plan: what it takes each month and week to reach the target by the date (an ESTIMATE)", async () => {
    const { svc } = build({ entries: [alloc(82000)], plan: { targetMonths: 6, targetDate: new Date(NOW.getTime() + 180 * 86_400_000), monthlyContribution: 10000 } });
    const o = await svc.overview("u1", NOW);
    expect(o.plan.basis).toBe("ESTIMATED");
    expect(o.plan).toMatchObject({
      monthlyContribution: "10000.00",
      requiredMonthly: "11333.33", // 68,000 over 6 months (180 days rounds up to 6)
      requiredWeekly: "2615.38", // 68,000 over 26 weeks
      monthsToTargetAtPlan: 7, // 68,000 / 10,000 rounded up
    });
    expect(o.plan.estimatedFinishDate).toBe(new Date(NOW.getTime() + 7 * 30.4375 * 86_400_000).toISOString());
  });

  it("a target date that is today or past gives no required amount (there is no time left to plan with)", async () => {
    const { svc } = build({ entries: [alloc(1000)], plan: { targetAmount: 50000, targetDate: NOW } });
    expect((await svc.overview("u1", NOW)).plan.requiredMonthly).toBeNull();
  });

  it("once the target is reached the required contribution is zero and no finish date is estimated", async () => {
    const { svc } = build({ entries: [alloc(60000)], plan: { targetAmount: 50000, targetDate: new Date(NOW.getTime() + 90 * 86_400_000), monthlyContribution: 5000 } });
    const o = await svc.overview("u1", NOW);
    expect(o.plan).toMatchObject({ requiredMonthly: "0.00", monthsToTargetAtPlan: 0, estimatedFinishDate: null });
  });

  it("totals, last activity and the 12-month trend come from the ledger", async () => {
    const { svc } = build({
      entries: [alloc(7000, "2026-08-10", "a1"), alloc(2000, "2026-10-01", "a2"), { id: "w1", type: "WITHDRAWAL", amount: 3000, occurredAt: d("2026-10-03") }],
    });
    const o = await svc.overview("u1", NOW);
    expect(o.totals).toMatchObject({ contributions: "9000.00", withdrawals: "3000.00", contributedThisMonth: "2000.00", contributedThisYear: "9000.00", withdrawnThisYear: "3000.00" });
    expect(o.last.contribution).toEqual({ date: d("2026-10-01").toISOString(), amount: "2000.00" });
    expect(o.last.withdrawal).toEqual({ date: d("2026-10-03").toISOString(), amount: "3000.00" });
    expect(o.trend).toHaveLength(12);
    expect(o.trend[11]).toEqual({ month: "2026-10", closingBalance: "6000.00", added: "2000.00", used: "3000.00" });
    expect(o.trend[10]).toMatchObject({ month: "2026-09", closingBalance: "7000.00" });
    expect(o.entryCount).toBe(3);
  });

  it("the balance and coverage come from the shared facts service, not a second calculation", async () => {
    const { svc } = build({ entries: [alloc(1000)] });
    await svc.overview("u1", NOW);
    expect((svc as any).facts.getEmergencyCoverage).toHaveBeenCalledWith("u1");
  });
});

describe("EmergencyFundService.ledger", () => {
  it("returns history newest-first with the balance after each entry, as money strings", async () => {
    const { svc } = build({ entries: [alloc(7000, "2026-09-01", "a"), { id: "b", type: "WITHDRAWAL", amount: 3000, occurredAt: d("2026-09-10"), reason: "Medical emergency" }] });
    const rows = await svc.ledger("u1");
    expect(rows.map((r) => [r.id, r.effect, r.balanceAfter, r.reason])).toEqual([["b", "-3000.00", "4000.00", "Medical emergency"], ["a", "7000.00", "7000.00", null]]);
  });
});

describe("EmergencyFundService.updatePlan", () => {
  it("sets a target amount and clears any months target (never both)", async () => {
    const { svc, getPlan } = build({ plan: { id: "p1", targetMonths: 6, targetAmount: null } });
    await svc.updatePlan("u1", { targetAmount: 200000 } as never, NOW);
    expect(getPlan()).toMatchObject({ targetAmount: 200000, targetMonths: null });
  });

  it("sets months and clears the amount", async () => {
    const { svc, getPlan } = build({ plan: { id: "p1", targetAmount: 90000, targetMonths: null } });
    await svc.updatePlan("u1", { targetMonths: 6 } as never, NOW);
    expect(getPlan()).toMatchObject({ targetMonths: 6, targetAmount: null });
  });

  it("rejects an amount AND months together", async () => {
    const { svc } = build();
    await expect(svc.updatePlan("u1", { targetAmount: 1000, targetMonths: 6 } as never, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("omitted fields are untouched; null clears", async () => {
    const { svc, getPlan } = build({ plan: { id: "p1", targetAmount: 90000, monthlyContribution: 5000, targetDate: d("2027-01-01") } });
    await svc.updatePlan("u1", { monthlyContribution: 7000 } as never, NOW);
    expect(getPlan()).toMatchObject({ targetAmount: 90000, monthlyContribution: 7000 });
    await svc.updatePlan("u1", { targetDate: null } as never, NOW);
    expect(getPlan()!.targetDate).toBeNull();
    await svc.updatePlan("u1", { targetAmount: null } as never, NOW);
    expect(getPlan()!.targetAmount).toBeNull();
  });

  it("creates the plan on first use, scoped to the caller", async () => {
    const { svc, db } = build();
    await svc.updatePlan("u1", { targetAmount: 50000 } as never, NOW);
    expect(db.emergencyFundPlan.upsert.mock.calls[0][0]).toMatchObject({ where: { userId: "u1" }, create: { userId: "u1", targetAmount: 50000 } });
  });

  it("rejects a past target date and an empty change", async () => {
    const { svc } = build();
    await expect(svc.updatePlan("u1", { targetDate: "2025-01-01" } as never, NOW)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.updatePlan("u1", {} as never, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("EmergencyFundService.useMoney — spec Part 24 / 59", () => {
  it("₹7,000 in, use ₹3,000 on a medical bill: reserve −₹3,000 AND one genuine ₹3,000 expense, in one transaction", async () => {
    const { svc, db, entries, expenses } = build({ entries: [alloc(7000)] });
    const out = await svc.useMoney("u1", { amount: 3000, occurredAt: "2026-10-05", reason: "Medical emergency", expense: { categoryId: "med" } } as never);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(entries.filter((e) => e.type === "WITHDRAWAL")).toHaveLength(1);
    expect(out.entry).toMatchObject({ type: "WITHDRAWAL", amount: 3000, reason: "Medical emergency" });
    expect(expenses).toEqual([
      expect.objectContaining({ userId: "u1", categoryId: "med", amount: 3000, flowType: "EXPENSE", merchant: "Medical emergency", notes: "Paid from emergency fund", spentAt: new Date("2026-10-05") }),
    ]);
    const balance = entries.reduce((a, r) => a.plus(emergencyReserveDelta({ type: r.type, amount: r.amount })), D(0));
    expect(balance.toNumber()).toBe(4000);
  });

  it("without an expense the money simply leaves the reserve — nothing is counted as spending", async () => {
    const { svc, expenses, entries } = build({ entries: [alloc(7000)] });
    await svc.useMoney("u1", { amount: 1000, occurredAt: "2026-10-05" } as never);
    expect(expenses).toHaveLength(0);
    expect(entries.some((e) => e.type === "WITHDRAWAL")).toBe(true);
  });

  it("cannot take out more than the reserve holds — and then NEITHER the withdrawal NOR the expense is written", async () => {
    const { svc, expenses, entries } = build({ entries: [alloc(2000)] });
    await expect(svc.useMoney("u1", { amount: 3000, occurredAt: "2026-10-05", expense: { categoryId: "med" } } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(entries).toHaveLength(1);
    expect(expenses).toHaveLength(0);
  });

  it("an expense cannot go into a savings/investment category, and nothing is written", async () => {
    const { svc, expenses, entries } = build({ entries: [alloc(7000)], categoryType: "SAVINGS" });
    await expect(svc.useMoney("u1", { amount: 100, occurredAt: "2026-10-05", expense: { categoryId: "sip" } } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(entries).toHaveLength(1);
    expect(expenses).toHaveLength(0);
  });

  it("an unknown category is refused before anything is written", async () => {
    const { svc, entries } = build({ entries: [alloc(7000)], categoryType: null });
    await expect(svc.useMoney("u1", { amount: 100, occurredAt: "2026-10-05", expense: { categoryId: "nope" } } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(entries).toHaveLength(1);
  });

  it("takes the per-user lock before reading the balance", async () => {
    const { svc, db } = build({ entries: [alloc(7000)] });
    await svc.useMoney("u1", { amount: 100, occurredAt: "2026-10-05" } as never);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.emergencyFundEntry.groupBy.mock.invocationCallOrder[0]);
  });
});

describe("EmergencyFundService.create — the reason is stored", () => {
  it("records the source of money added (Part 19)", async () => {
    const { svc, entries } = build();
    await svc.create("u1", { type: "ALLOCATE", amount: 7000, occurredAt: "2026-10-01", reason: "Bonus", notes: "Diwali" } as never);
    expect(entries[0]).toMatchObject({ type: "ALLOCATE", amount: 7000, reason: "Bonus", notes: "Diwali" });
  });
});
