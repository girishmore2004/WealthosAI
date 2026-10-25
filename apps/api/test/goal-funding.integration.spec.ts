// REAL-DATABASE integration tests for Money → Goals (goal funding ledger).
// Runs the real services against a real Postgres. Skipped unless TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgresql://user:pw@localhost:5432/wealthos_test npx jest test/goal-funding.integration.spec.ts
// (the database must already have the migrations applied; every test uses its own throw-away users).
// Set TEST_PRISMA_WASM_CLIENT=<path to node_modules/.prisma/client/wasm.js> to use the driver-adapter client
// instead of the native engine (needs @prisma/adapter-pg and pg).

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { EmergencyFundService } from "../src/financial-core/emergency-fund/emergency-fund.service";
import { GoalFundingService } from "../src/financial-core/goal-funding/goal-funding.service";
import { GoalsService } from "../src/goals/goals.service";
import { FinancialFactsService } from "../src/common/financial-facts/financial-facts.service";
import { IncomeService } from "../src/income/income.service";
import { ExpensesService } from "../src/expenses/expenses.service";

const URL = process.env.TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip;

suite("Money → Goals against a real database", () => {
  let client: any;
  let pool: any;
  let ef: EmergencyFundService;
  let funding: GoalFundingService;
  let goals: GoalsService;
  let facts: FinancialFactsService;
  let needCat = "";
  let savingsCat = "";

  const TODAY = new Date().toISOString().slice(0, 10);
  const FUTURE = (months: number) => new Date(Date.now() + months * 30.4375 * 86_400_000).toISOString();
  const rid = () => `req_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const n = (v: unknown) => Number(v);

  beforeAll(async () => {
    const wasm = process.env.TEST_PRISMA_WASM_CLIENT;
    if (wasm) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PrismaClient } = require(wasm);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PrismaPg } = require("@prisma/adapter-pg");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Pool } = require("pg");
      pool = new Pool({ connectionString: URL });
      client = new PrismaClient({ adapter: new PrismaPg(pool) });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PrismaClient } = require("@prisma/client");
      client = new PrismaClient({ datasources: { db: { url: URL } } });
    }
    const prisma = { client } as never;
    facts = new FinancialFactsService(prisma, new IncomeService(prisma), new ExpensesService(prisma));
    ef = new EmergencyFundService(prisma, facts);
    funding = new GoalFundingService(prisma, facts, ef);
    goals = new GoalsService(prisma, funding);
    needCat = (await client.category.upsert({ where: { name: "IT Medical" }, update: {}, create: { name: "IT Medical", type: "NEED" } })).id;
    savingsCat = (await client.category.upsert({ where: { name: "IT Savings" }, update: {}, create: { name: "IT Savings", type: "SAVINGS" } })).id;
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.end();
  });

  async function newUser(): Promise<string> {
    const id = `it_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await client.user.create({ data: { id, email: `${id}@test.local` } });
    return id;
  }
  const mkGoal = (u: string, type: string, name: string, target: number, months = 12, extra: Record<string, unknown> = {}) =>
    goals.create(u, { type, name, targetAmount: target, targetDate: FUTURE(months), ...extra } as never);
  const add = (u: string, goalId: string, amount: number, requestId = rid()) =>
    funding.addEntry(u, goalId, { type: "ALLOCATE", amount, occurredAt: TODAY, requestId } as never);
  const bal = async (goalId: string) => n((await client.goal.findUnique({ where: { id: goalId } })).currentAmount);
  const reserve = async (u: string) => {
    const rows = await client.emergencyFundEntry.findMany({ where: { userId: u } });
    return rows.reduce((a: number, r: any) => a + (["ALLOCATE", "TRANSFER_IN"].includes(r.type) ? n(r.amount) : r.type === "ADJUSTMENT" ? n(r.amount) : -n(r.amount)), 0);
  };
  const position = (u: string) => facts.getFinancialPosition(u);

  // -------------------------------------------------------------------------------------------
  it("1. emergency fund: the existing reserve flow still works end to end and maps to the emergency goal", async () => {
    const u = await newUser();
    const g = await mkGoal(u, "EMERGENCY_FUND", "Emergency fund", 150000, 12);
    expect(g.fundingBacking).toBe("RESERVE");

    // Contribute through the OLD service (the existing page) and through the new one — one ledger.
    await ef.create(u, { type: "ALLOCATE", amount: 40000, occurredAt: TODAY } as never);
    await add(u, g.id, 10000);
    expect(await reserve(u)).toBe(50000);
    expect(await bal(g.id)).toBe(50000); // Goal.currentAmount is the materialised reserve balance
    expect(await client.goalEntry.count({ where: { userId: u } })).toBe(0); // no second ledger

    const o = await funding.overview(u, g.id);
    expect(o.balance).toBe("50000.00");
    expect(o.goal.backing).toBe("RESERVE");
    expect(o.coverage).not.toBeNull();
    expect(o.progress).toMatchObject({ remaining: "100000.00", reached: false });
    expect(o.rules.supportsCoverage).toBe(true);

    // Withdraw as a genuine expense: reserve −3,000 and exactly one ₹3,000 EXPENSE.
    const used = await funding.useMoney(u, g.id, { amount: 3000, occurredAt: TODAY, reason: "Hospital", spend: { mode: "EXPENSE", categoryId: needCat }, requestId: rid() } as never);
    expect(used.expense).toMatchObject({ amount: "3000.00", flowType: "EXPENSE" });
    expect(await reserve(u)).toBe(47000);
    expect(await bal(g.id)).toBe(47000);
    const exp = await client.expense.findMany({ where: { userId: u } });
    expect(exp).toHaveLength(1);
    expect(n(exp[0].amount)).toBe(3000);
    expect(exp[0].flowType).toBe("EXPENSE");

    // The old emergency page's history agrees with the new one.
    const ledger = await funding.ledger(u, g.id);
    expect(ledger.map((r) => r.type).sort()).toEqual(["ALLOCATE", "ALLOCATE", "WITHDRAWAL"]);
    expect(ledger[0].balanceAfter).toBe("47000.00");
  });

  it("2 + 3. house and vacation are independent: money moves only the chosen goal, and cash is untouched", async () => {
    const u = await newUser();
    const house = await mkGoal(u, "HOUSE", "House", 2_000_000, 60);
    const trip = await mkGoal(u, "VACATION", "Goa trip", 80000, 8);
    const before = await position(u);

    await add(u, house.id, 100000);
    await add(u, trip.id, 20000);
    await add(u, house.id, 5000);

    expect(await bal(house.id)).toBe(105000);
    expect(await bal(trip.id)).toBe(20000);
    expect(await reserve(u)).toBe(0);

    // A goal earmark is not a cash movement: Available Cash, Emergency Cash, net worth and expenses are unchanged.
    const after = await position(u);
    expect(after.cash).toEqual(before.cash);
    expect(after.netWorth).toBe(before.netWorth);
    expect(after.expenses).toBe(before.expenses);
    expect(after.income).toBe(before.income);

    const [h, t] = await Promise.all([funding.overview(u, house.id), funding.overview(u, trip.id)]);
    expect(h.balance).toBe("105000.00");
    expect(t.balance).toBe("20000.00");
    expect(h.coverage).toBeNull();
    expect(h.progress.remaining).toBe("1895000.00");
    expect(t.progress.remaining).toBe("60000.00");
    expect(await funding.ledger(u, house.id)).toHaveLength(2);
    expect(await funding.ledger(u, trip.id)).toHaveLength(1);
  });

  it("3. withdrawal / goal spending: EXPENSE counts once, OTHER_OUTFLOW is not spending, plain use is neither", async () => {
    const u = await newUser();
    const trip = await mkGoal(u, "VACATION", "Trip", 80000, 8);
    const house = await mkGoal(u, "HOUSE", "House", 900000, 30);
    await add(u, trip.id, 30000);
    await add(u, house.id, 200000);

    const a = await funding.useMoney(u, trip.id, { amount: 12000, occurredAt: TODAY, reason: "Flights", spend: { mode: "EXPENSE", categoryId: needCat }, requestId: rid() } as never);
    const b = await funding.useMoney(u, house.id, { amount: 150000, occurredAt: TODAY, reason: "Down payment", spend: { mode: "OTHER_OUTFLOW", categoryId: needCat }, requestId: rid() } as never);
    const c = await funding.useMoney(u, trip.id, { amount: 1000, occurredAt: TODAY, requestId: rid() } as never);

    expect(a.expense?.flowType).toBe("EXPENSE");
    expect(b.expense?.flowType).toBe("OTHER_OUTFLOW");
    expect(c.expense).toBeNull();
    expect(await bal(trip.id)).toBe(17000);
    expect(await bal(house.id)).toBe(50000);

    const rows = await client.expense.findMany({ where: { userId: u }, orderBy: { amount: "asc" } });
    expect(rows.map((r: any) => [n(r.amount), r.flowType])).toEqual([[12000, "EXPENSE"], [150000, "OTHER_OUTFLOW"]]);
    // Spending counted once: only the EXPENSE row is in expenses.
    expect((await position(u)).expenses).toBe("12000.00");

    // A savings category can never be used to record spending; nothing is written when it is refused.
    await expect(
      funding.useMoney(u, trip.id, { amount: 500, occurredAt: TODAY, spend: { mode: "EXPENSE", categoryId: savingsCat }, requestId: rid() } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await bal(trip.id)).toBe(17000);
  });

  it("never overdraws a goal, and refuses spend modes a goal type does not support", async () => {
    const u = await newUser();
    const trip = await mkGoal(u, "VACATION", "Trip", 50000, 6);
    await add(u, trip.id, 1000);
    await expect(funding.useMoney(u, trip.id, { amount: 1000.01, occurredAt: TODAY, requestId: rid() } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(await bal(trip.id)).toBe(1000);

    const ret = await mkGoal(u, "RETIREMENT", "Retire", 5_000_000, 240);
    expect(funding.overview(u, ret.id)).resolves.toMatchObject({ rules: { spendModes: [] } });
    await add(u, ret.id, 5000);
    await expect(
      funding.useMoney(u, ret.id, { amount: 100, occurredAt: TODAY, spend: { mode: "EXPENSE", categoryId: needCat }, requestId: rid() } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("move money: paired legs, no cash/net-worth/expense change, one request id, and deleting one leg removes both", async () => {
    const u = await newUser();
    const trip = await mkGoal(u, "VACATION", "Trip", 50000, 6);
    const car = await mkGoal(u, "CAR", "Car", 600000, 24);
    const emergency = await mkGoal(u, "EMERGENCY_FUND", "Emergency fund", 150000, 12);
    await add(u, trip.id, 10000);
    await add(u, emergency.id, 30000);
    const before = await position(u);

    const r = await funding.reallocate(u, trip.id, { toGoalId: car.id, amount: 4000, occurredAt: TODAY, requestId: rid() } as never);
    expect(await bal(trip.id)).toBe(6000);
    expect(await bal(car.id)).toBe(4000);

    // Between a goal and the emergency reserve both ledgers move, still without touching income/expenses/net worth.
    const toTrip = await funding.reallocate(u, emergency.id, { toGoalId: trip.id, amount: 5000, occurredAt: TODAY, requestId: rid() } as never);
    expect(await reserve(u)).toBe(25000);
    expect(await bal(emergency.id)).toBe(25000);
    expect(await bal(trip.id)).toBe(11000);
    const mid = await position(u);
    expect(mid.expenses).toBe(before.expenses);
    expect(mid.income).toBe(before.income);

    // Replay of the same request creates nothing new.
    const rq = rid();
    const first = await funding.reallocate(u, trip.id, { toGoalId: car.id, amount: 1000, occurredAt: TODAY, requestId: rq } as never);
    const again = await funding.reallocate(u, trip.id, { toGoalId: car.id, amount: 1000, occurredAt: TODAY, requestId: rq } as never);
    expect(again.replayed).toBe(true);
    expect(again.groupId).toBe(first.groupId);
    expect(await bal(car.id)).toBe(5000);

    // A move cannot be edited leg by leg: deleting one leg undoes the pair atomically.
    await funding.removeEntry(u, car.id, r.to.entryId);
    expect(await bal(car.id)).toBe(1000);
    expect(await bal(trip.id)).toBe(11000 - 1000 + 4000);
    expect(await client.goalEntry.count({ where: { userId: u, transferGroupId: r.groupId } })).toBe(0);

    // The reserve leg of a move cannot be deleted through the old emergency endpoint either.
    const reserveLeg = await client.emergencyFundEntry.findFirst({ where: { userId: u, transferGroupId: toTrip.groupId } });
    await expect(ef.remove(u, reserveLeg.id)).rejects.toBeInstanceOf(BadRequestException);

    await expect(funding.reallocate(u, trip.id, { toGoalId: trip.id, amount: 1, occurredAt: TODAY } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(funding.reallocate(u, car.id, { toGoalId: trip.id, amount: 999999, occurredAt: TODAY } as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("5. a goal created after the feature shipped (any type, any name) gets the full detail view with no code change", async () => {
    const u = await newUser();
    for (const type of ["MARRIAGE", "CHILD_EDUCATION", "LAND", "BUSINESS_EXPANSION", "HEALTHCARE_RESERVE"]) {
      const g = await mkGoal(u, type, `New ${type}`, 100000, 18);
      await add(u, g.id, 2500);
      const o = await funding.overview(u, g.id);
      expect(o.balance).toBe("2500.00");
      expect(o.goal.backing).toBe("GOAL_LEDGER");
      expect(o.rules.addSources.length).toBeGreaterThan(0);
      expect(o.rules.typeLabel).toBeTruthy();
    }
    const list = await funding.listFunds(u);
    expect(list).toHaveLength(5);
    expect(list.every((f) => f.cashBalance === "2500.00" && f.entryCount === 1)).toBe(true);
  });

  it("6. fully funded goal: zero shortfall, reached; overfunded stays at zero; no deadline means no required monthly", async () => {
    const u = await newUser();
    const g = await mkGoal(u, "CAR", "Car", 50000, 6);
    await add(u, g.id, 50000);
    let s = (await funding.listFunds(u))[0];
    expect(s).toMatchObject({ shortfall: "0.00", reached: true, progressPercent: 100 });
    await add(u, g.id, 5000);
    s = (await funding.listFunds(u))[0];
    expect(s.shortfall).toBe("0.00");
    const o = await funding.overview(u, g.id);
    expect(o.progress).toMatchObject({ remaining: "0.00", reached: true });

    await funding.updatePlan(u, g.id, { targetDate: null, targetAmount: 90000 } as never);
    const o2 = await funding.overview(u, g.id);
    expect(o2.goal.hasTargetDate).toBe(false);
    expect(o2.plan.requiredMonthly).toBeNull();
    expect(o2.progress.remaining).toBe("35000.00");
  });

  it("6. monthly requirement and target changes agree between Goals overview and Money → Goals", async () => {
    const u = await newUser();
    const g = await mkGoal(u, "HOUSE", "House", 120000, 12, { monthlyContribution: 5000 });
    await add(u, g.id, 24000);
    await funding.updatePlan(u, g.id, { targetAmount: 240000, monthlyContribution: 9000 } as never);
    const overview = await funding.overview(u, g.id);
    const fromGoals = (await goals.list(u)).find((x) => x.id === g.id)!;
    expect(n(fromGoals.targetAmount)).toBe(240000);
    expect(fromGoals.shortfall).toBe(overview.progress.remaining);
    expect(overview.progress.remaining).toBe("216000.00");
    expect(fromGoals.requiredMonthlyContribution).toBe(n(overview.plan.requiredMonthly));
    expect(n(overview.plan.requiredMonthly)).toBeGreaterThan(0);
    // An unsupported change for an ordinary goal is refused and changes nothing.
    await expect(funding.updatePlan(u, g.id, { targetMonths: 6 } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(funding.updatePlan(u, g.id, { targetAmount: null } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(n((await client.goal.findUnique({ where: { id: g.id } })).targetAmount)).toBe(240000);
  });

  it("6. duplicate requests: same requestId in parallel writes exactly one entry", async () => {
    const u = await newUser();
    const g = await mkGoal(u, "VACATION", "Trip", 90000, 8);
    const rq = rid();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => add(u, g.id, 1000, rq)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await client.goalEntry.count({ where: { userId: u, goalId: g.id } })).toBe(1);
    expect(await bal(g.id)).toBe(1000);

    const sameUse = rid();
    await add(u, g.id, 5000);
    await Promise.all(Array.from({ length: 4 }, () => funding.useMoney(u, g.id, { amount: 700, occurredAt: TODAY, spend: { mode: "EXPENSE", categoryId: needCat }, requestId: sameUse } as never)));
    expect(await client.expense.count({ where: { userId: u } })).toBe(1);
    expect(await bal(g.id)).toBe(5300);
  });

  it("6. concurrent withdrawals cannot overdraw a goal (per-user lock)", async () => {
    const u = await newUser();
    const g = await mkGoal(u, "VACATION", "Trip", 90000, 8);
    await add(u, g.id, 100);
    const res = await Promise.allSettled([
      funding.useMoney(u, g.id, { amount: 60, occurredAt: TODAY, requestId: rid() } as never),
      funding.useMoney(u, g.id, { amount: 60, occurredAt: TODAY, requestId: rid() } as never),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await bal(g.id)).toBe(40);
  });

  it("6. user isolation: another user cannot read or change a goal, ledger, entry or move into it", async () => {
    const a = await newUser();
    const b = await newUser();
    const ga = await mkGoal(a, "VACATION", "A trip", 50000, 6);
    const gb = await mkGoal(b, "VACATION", "B trip", 50000, 6);
    const entry = await add(a, ga.id, 1000);
    await add(b, gb.id, 500);

    await expect(funding.overview(b, ga.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(funding.ledger(b, ga.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(add(b, ga.id, 10)).rejects.toBeInstanceOf(NotFoundException);
    await expect(funding.useMoney(b, ga.id, { amount: 10, occurredAt: TODAY, requestId: rid() } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(funding.reallocate(b, gb.id, { toGoalId: ga.id, amount: 10, occurredAt: TODAY, requestId: rid() } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(funding.removeEntry(b, ga.id, (entry as any).id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(goals.update(b, ga.id, { name: "hijack" } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(goals.remove(b, ga.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await bal(ga.id)).toBe(1000);
    expect((await funding.listFunds(b)).map((f) => f.id)).toEqual([gb.id]);

    // The same requestId used by two users is two independent requests.
    const shared = rid();
    await add(a, ga.id, 1, shared);
    await add(b, gb.id, 1, shared);
    expect(await bal(ga.id)).toBe(1001);
    expect(await bal(gb.id)).toBe(501);
  });

  it("lifecycle: opening balance, edit guards, archive (release + unlink) and restore", async () => {
    const u = await newUser();
    const g = await mkGoal(u, "CAR", "Car", 400000, 20, { currentAmount: 25000 });
    expect(await bal(g.id)).toBe(25000);
    const led = await funding.ledger(u, g.id);
    expect(led).toHaveLength(1);
    expect(led[0].origin).toBe("OPENING_BALANCE");

    // currentAmount can only be changed through the ledger.
    await expect(goals.update(u, g.id, { currentAmount: 1 } as never)).rejects.toBeInstanceOf(BadRequestException);
    // The type is locked once the goal has history.
    await expect(goals.update(u, g.id, { type: "HOUSE" } as never)).rejects.toBeInstanceOf(BadRequestException);
    await goals.update(u, g.id, { name: "Electric car", targetAmount: 450000 } as never);

    const inv = await client.investment.create({ data: { userId: u, type: "MUTUAL_FUND", name: "Fund", investedAmount: 1000, currentValue: 1100, goalId: g.id, startDate: new Date() } }).catch(() => null);
    const removed = await goals.remove(u, g.id);
    expect(removed.archived).toBe(true);
    expect(removed.releasedAmount).toBe("25000.00");
    expect(await bal(g.id)).toBe(0);
    expect((await goals.list(u)).find((x) => x.id === g.id)).toBeUndefined();
    expect((await goals.list(u, { includeArchived: true })).find((x) => x.id === g.id)?.archivedAt).toBeTruthy();
    if (inv) expect((await client.investment.findUnique({ where: { id: inv.id } })).goalId).toBeNull();
    await expect(add(u, g.id, 10)).rejects.toBeInstanceOf(BadRequestException);

    await goals.restore(u, g.id);
    expect((await goals.list(u)).find((x) => x.id === g.id)).toBeDefined();
    await add(u, g.id, 10);

    // A goal with no history is simply deleted, not archived.
    const empty = await mkGoal(u, "LAND", "Plot", 100000, 30);
    await goals.remove(u, empty.id);
    expect(await client.goal.findUnique({ where: { id: empty.id } })).toBeNull();
  });

  it("emergency goal: a second one is refused; with history it cannot be removed; reserve is never double counted", async () => {
    const u = await newUser();
    const e = await mkGoal(u, "EMERGENCY_FUND", "Emergency fund", 150000, 12);
    await expect(mkGoal(u, "EMERGENCY_FUND", "Second", 1000, 12)).rejects.toBeInstanceOf(BadRequestException);
    await ef.create(u, { type: "ALLOCATE", amount: 10000, occurredAt: TODAY } as never);
    await expect(goals.remove(u, e.id)).rejects.toBeInstanceOf(BadRequestException);

    // The reserve lowers Available Cash exactly once, however many places display it.
    const p = await position(u);
    expect(p.cash.emergency).toBe("10000.00");
    expect(n(p.cash.total)).toBe(n(p.cash.available) + 10000);
    const summaries = await funding.listFunds(u);
    expect(summaries.filter((s) => s.backing === "RESERVE")).toHaveLength(1);
    expect(summaries[0].cashBalance).toBe("10000.00");
  });
});
