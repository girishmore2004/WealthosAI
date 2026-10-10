import { BadRequestException } from "@nestjs/common";
import { ExpensesService } from "../src/expenses/expenses.service";

// Fixed "today" is passed explicitly on every call, so nothing here depends on the real clock.
const TODAY = "2026-10-15";

type Sums = Record<string, { sum: number; count?: number }>;

function build(sums: Sums, daily: Array<{ day: string; total: number; count: number }> = []) {
  const db = {
    expense: {
      // Dispatch on the window start + whether the query is category-restricted, so each call in
      // analytics() (range / previous month / same month last year / all-category) gets its own total.
      aggregate: jest.fn(async ({ where }: any) => {
        const key = `${where.spentAt.gte.toISOString().slice(0, 10)}|${where.categoryId ?? "all"}`;
        const r = sums[key];
        return { _sum: { amount: r ? r.sum : null }, _count: { _all: r?.count ?? 0 } };
      }),
      findFirst: jest.fn(async ({ orderBy }: any) =>
        orderBy[0].amount === "desc"
          ? { id: "big", amount: 4000, spentAt: new Date("2026-10-10T00:00:00Z"), merchant: "Big Bazaar", category: { name: "Grocery" } }
          : { id: "small", amount: 40, spentAt: new Date("2026-10-03T00:00:00Z"), merchant: null, category: { name: "Grocery" } },
      ),
      groupBy: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    category: { findMany: jest.fn(), findUnique: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue(daily.map((r) => ({ ...r, day: new Date(`${r.day}T00:00:00Z`) }))),
  };
  // current window vs the comparison window (the previous calendar month, Sept 2026, starts 2026-09-01)
  db.expense.groupBy.mockImplementation(async ({ where }: any) =>
    where.spentAt.gte.toISOString().slice(0, 10) === "2026-09-01"
      ? [{ categoryId: "c1", _sum: { amount: 7200 } }]
      : [{ categoryId: "c1", _sum: { amount: 8500 }, _count: { _all: 4 } }],
  );
  db.category.findMany.mockResolvedValue([{ id: "c1", name: "Grocery", type: "NEED", icon: "🛒" }]);
  return { db, svc: new ExpensesService({ client: db } as never) };
}

describe("ExpensesService.analytics", () => {
  const octSums: Sums = {
    "2026-10-01|all": { sum: 8500, count: 4 },
    "2026-09-01|all": { sum: 7200 },
    "2025-10-01|all": { sum: 5000 },
  };
  const octDaily = [
    { day: "2026-10-03", total: 3000, count: 2 },
    { day: "2026-10-10", total: 5500, count: 2 },
  ];

  it("spec example: October grocery ₹8,500 vs September ₹7,200 is +18.1%", async () => {
    const { svc } = build(octSums, octDaily);
    const out = await svc.analytics("u1", { period: "THIS_MONTH", today: TODAY });

    expect(out.basis).toBe("ACTUAL");
    expect(out.totals.total).toBe("8500.00");
    expect(out.comparison).toMatchObject({ from: "2026-09-01", to: "2026-09-30", total: "7200.00", change: "1300.00", changePercent: 18.1 });
    expect(out.yearOverYear).toMatchObject({ from: "2025-10-01", total: "5000.00", changePercent: 70 });
  });

  it("averages divide by the days that have ELAPSED, not the whole month", async () => {
    const { svc } = build(octSums, octDaily);
    const out = await svc.analytics("u1", { period: "THIS_MONTH", today: TODAY });
    expect(out.period).toMatchObject({ from: "2026-10-01", to: "2026-10-31", days: 31, elapsedDays: 15 });
    expect(out.totals.averagePerDay).toBe("566.67"); // 8500 / 15
    expect(out.totals.averagePerTransaction).toBe("2125.00"); // 8500 / 4
    expect(out.totals.transactionCount).toBe(4);
    expect(out.totals.largest).toMatchObject({ id: "big", amount: "4000.00", merchant: "Big Bazaar", categoryName: "Grocery" });
    expect(out.totals.smallest).toMatchObject({ id: "small", amount: "40.00", merchant: null });
  });

  it("zero-fills the daily series up to today only and picks highest/lowest among spending days", async () => {
    const { svc } = build(octSums, octDaily);
    const out = await svc.analytics("u1", { period: "THIS_MONTH", today: TODAY });
    expect(out.daily).toHaveLength(15); // Oct 1..15, none of the future days
    expect(out.daily[0]).toEqual({ date: "2026-10-01", total: "0.00", count: 0 });
    expect(out.daily[2]).toEqual({ date: "2026-10-03", total: "3000.00", count: 2 });
    expect(out.highestDay).toEqual({ date: "2026-10-10", total: "5500.00" });
    expect(out.lowestDay).toEqual({ date: "2026-10-03", total: "3000.00" }); // a ₹0 day is "no spending", not the lowest
  });

  it("folds daily rows into Monday-start weeks and calendar months", async () => {
    const { svc } = build(octSums, octDaily);
    const out = await svc.analytics("u1", { period: "THIS_MONTH", today: TODAY });
    expect(out.weekly).toEqual([
      { weekStart: "2026-09-28", total: "3000.00", count: 2 },
      { weekStart: "2026-10-05", total: "5500.00", count: 2 },
      { weekStart: "2026-10-12", total: "0.00", count: 0 },
    ]);
    expect(out.monthly).toEqual([{ month: "2026-10", total: "8500.00", count: 4 }]);
  });

  it("returns category totals with their share of the period", async () => {
    const { svc } = build(octSums, octDaily);
    const out = await svc.analytics("u1", { period: "THIS_MONTH", today: TODAY });
    // Spec example: Grocery October ₹8,500 vs September ₹7,200 → +18.1%
    expect(out.categories).toEqual([
      { categoryId: "c1", name: "Grocery", type: "NEED", icon: "🛒", total: "8500.00", count: 4, sharePercent: 100, previousTotal: "7200.00", changePercent: 18.1 },
    ]);
    expect(out.overall).toBeNull();
  });

  it("category drill-down: restricts every figure to the category and reports its share of ALL expenses", async () => {
    const { db, svc } = build({
      "2026-10-01|c1": { sum: 8500, count: 4 },
      "2026-09-01|c1": { sum: 7200 },
      "2025-10-01|c1": { sum: 0 },
      "2026-10-01|all": { sum: 38000 },
    }, octDaily);
    const out = await svc.analytics("u1", { period: "THIS_MONTH", today: TODAY, categoryId: "c1" });

    expect(out.filters.categoryId).toBe("c1");
    expect(out.overall).toEqual({ total: "38000.00", sharePercent: 22.4 }); // spec example: 22.4%
    expect(out.yearOverYear).toBeNull(); // nothing spent a year ago → no misleading year-over-year
    const [rangeCall] = db.expense.aggregate.mock.calls.map((c: any[]) => c[0].where).filter((w: any) => w.categoryId === "c1");
    expect(rangeCall.categoryId).toBe("c1");
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("every query counts only the requested flow type and excludes legacy SAVINGS rows", async () => {
    const { db, svc } = build(octSums, octDaily);
    await svc.analytics("u1", { period: "THIS_MONTH", today: TODAY });
    for (const [{ where }] of db.expense.aggregate.mock.calls) {
      expect(where).toMatchObject({ userId: "u1", flowType: "EXPENSE", category: { type: { not: "SAVINGS" } } });
    }
    await svc.analytics("u1", { period: "THIS_MONTH", today: TODAY, flowType: "OTHER_OUTFLOW" });
    expect(db.expense.aggregate.mock.calls.at(-1)![0].where.flowType).toBe("OTHER_OUTFLOW");
  });

  it("returns no changePercent (not Infinity) when the comparison period was empty", async () => {
    const { svc } = build({ "2026-10-01|all": { sum: 100, count: 1 } });
    const out = await svc.analytics("u1", { period: "THIS_MONTH", today: TODAY });
    expect(out.comparison.changePercent).toBeNull();
    expect(out.comparison.total).toBe("0.00");
  });

  it("handles an empty period without dividing by zero", async () => {
    const { svc } = build({});
    const out = await svc.analytics("u1", { period: "TODAY", today: TODAY });
    expect(out.totals).toMatchObject({ total: "0.00", transactionCount: 0, averagePerTransaction: null, averagePerDay: "0.00" });
    expect(out.highestDay).toBeNull();
    expect(out.lowestDay).toBeNull();
  });

  it("supports custom inclusive ranges and rejects incomplete or oversized ones", async () => {
    const { svc } = build({});
    const out = await svc.analytics("u1", { from: "2026-10-01", to: "2026-10-03", today: TODAY });
    expect(out.period).toMatchObject({ from: "2026-10-01", to: "2026-10-03", days: 3 });
    await expect(svc.analytics("u1", { from: "2026-10-01", today: TODAY })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.analytics("u1", { period: "CUSTOM", today: TODAY })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.analytics("u1", { from: "2020-01-01", to: "2026-01-01", today: TODAY })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("defaults to the current month when nothing is specified", async () => {
    const { svc } = build({});
    const out = await svc.analytics("u1", { today: TODAY });
    expect(out.period).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
  });
});

describe("ExpensesService.quickCreate (Part 56: ₹500 Grocery)", () => {
  const setup = () => {
    const sums: Sums = {
      "2026-10-04|c1": { sum: 500 }, // Grocery today
      "2026-10-04|all": { sum: 500 }, // all expenses today
      "2026-10-01|c1": { sum: 8500 }, // Grocery this month (previous 8,000 + 500)
      "2026-10-01|all": { sum: 15420 },
      "2026-01-01|c1": { sum: 61000 },
      "2026-01-01|all": { sum: 190000 },
    };
    const fake = build(sums);
    fake.db.category.findUnique.mockResolvedValue({ type: "NEED", name: "Grocery" });
    fake.db.expense.create.mockImplementation(async ({ data }: any) => ({ id: "e1", ...data, flowType: data.flowType ?? "EXPENSE" }));
    return fake;
  };

  it("saves a canonical Expense with today/UPI defaults and reports what it changed", async () => {
    const { db, svc } = setup();
    const out = await svc.quickCreate("u1", { categoryId: "c1", amount: 500, merchant: "Big Basket", spentAt: "2026-10-04" } as never);

    const data = db.expense.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: "u1", categoryId: "c1", amount: 500, paymentMethod: "UPI" });
    expect(data.recurrence).toBeUndefined();
    expect(data.recurrenceActive).toBeUndefined();

    expect(out.impact).toMatchObject({
      basis: "ACTUAL",
      date: "2026-10-04",
      flowType: "EXPENSE",
      day: { categoryTotal: "500.00", allCategoriesTotal: "500.00" },
      month: { categoryTotal: "8500.00", allCategoriesTotal: "15420.00" },
      year: { categoryTotal: "61000.00", allCategoriesTotal: "190000.00" },
    });
  });

  it("only ever touches the expense table (no investment, emergency or receivable write)", async () => {
    const { db, svc } = setup();
    await svc.quickCreate("u1", { categoryId: "c1", amount: 500, spentAt: "2026-10-04" } as never);
    expect(Object.keys(db).sort()).toEqual(["$queryRaw", "category", "expense"]);
    expect(db.expense.create).toHaveBeenCalledTimes(1);
  });

  it("defaults the date to today when none is sent", async () => {
    const { db, svc } = setup();
    await svc.quickCreate("u1", { categoryId: "c1", amount: 10 } as never);
    expect(db.expense.create.mock.calls[0][0].data.spentAt.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });

  it("saves the row AS the recurrence template in the same write (no future rows are created)", async () => {
    const { db, svc } = setup();
    await svc.quickCreate("u1", { categoryId: "c1", amount: 999, spentAt: "2026-10-04", recurrence: "MONTHLY", recurrenceEndDate: "2027-03-31" } as never);
    expect(db.expense.create).toHaveBeenCalledTimes(1);
    const data = db.expense.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ isRecurring: true, recurrence: "MONTHLY", recurrenceActive: true });
    expect(data.nextOccurrenceAt).toEqual(data.spentAt);
    expect(data.recurrenceEndDate).toEqual(new Date("2027-03-31"));
  });

  it("treats ONE_TIME as no recurrence", async () => {
    const { db, svc } = setup();
    await svc.quickCreate("u1", { categoryId: "c1", amount: 10, spentAt: "2026-10-04", recurrence: "ONE_TIME" } as never);
    expect(db.expense.create.mock.calls[0][0].data.recurrenceActive).toBeUndefined();
  });

  it("rejects an end date without a cadence, and an end date before the first expense", async () => {
    const { db, svc } = setup();
    await expect(svc.quickCreate("u1", { categoryId: "c1", amount: 10, spentAt: "2026-10-04", recurrenceEndDate: "2027-01-01" } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.quickCreate("u1", { categoryId: "c1", amount: 10, spentAt: "2026-10-04", recurrence: "WEEKLY", recurrenceEndDate: "2026-09-01" } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.expense.create).not.toHaveBeenCalled();
  });

  it("still refuses a SAVINGS category (investments are not expenses)", async () => {
    const { db, svc } = setup();
    db.category.findUnique.mockResolvedValue({ type: "SAVINGS", name: "SIP" });
    await expect(svc.quickCreate("u1", { categoryId: "c-sip", amount: 5000, spentAt: "2026-10-04" } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.expense.create).not.toHaveBeenCalled();
  });
});

describe("ExpensesService filters and flow type", () => {
  const make = () => {
    const db = { expense: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } };
    return { db, svc: new ExpensesService({ client: db } as never) };
  };

  it("list() is the SPENDING view: only flowType EXPENSE rows feed every total", async () => {
    const { db, svc } = make();
    await svc.list("u1", "2026-10");
    expect(db.expense.findMany.mock.calls[0][0].where).toMatchObject({ userId: "u1", flowType: "EXPENSE" });
  });

  it("listPaged applies flow type, payment method and a server-resolved period together", async () => {
    const { db, svc } = make();
    await svc.listPaged("u1", { flowType: "OTHER_OUTFLOW", paymentMethod: "CASH", period: "THIS_WEEK", today: "2026-10-04" });
    const where = db.expense.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: "u1", flowType: "OTHER_OUTFLOW", paymentMethod: "CASH" });
    expect(where.spentAt.gte.toISOString().slice(0, 10)).toBe("2026-09-28");
    expect(where.spentAt.lt.toISOString().slice(0, 10)).toBe("2026-10-05");
  });

  it("listPaged without new filters keeps the original where clause (backward compatible)", async () => {
    const { db, svc } = make();
    await svc.listPaged("u1", {});
    expect(db.expense.findMany.mock.calls[0][0].where).toEqual({ userId: "u1" });
  });

  it.each([
    ["NEWEST", [{ spentAt: "desc" }, { createdAt: "desc" }]],
    [undefined, [{ spentAt: "desc" }, { createdAt: "desc" }]],
    ["OLDEST", [{ spentAt: "asc" }, { createdAt: "asc" }]],
    ["HIGHEST", [{ amount: "desc" }, { spentAt: "desc" }]],
    ["LOWEST", [{ amount: "asc" }, { spentAt: "desc" }]],
  ] as const)("sort %s orders deterministically", async (sort, expected) => {
    const { db, svc } = make();
    await svc.listPaged("u1", { sort: sort as never });
    expect(db.expense.findMany.mock.calls[0][0].orderBy).toEqual(expected);
  });
});

describe("ExpensesService.periodTotals (the expense page header)", () => {
  it("returns today / this month / this year for the caller's local date, spending only", async () => {
    const seen: string[] = [];
    const db = {
      expense: {
        aggregate: jest.fn(async ({ where }: any) => {
          seen.push(where.spentAt.gte.toISOString().slice(0, 10));
          const sums: Record<string, number> = { "2026-10-04": 500, "2026-10-01": 15420, "2026-01-01": 190000 };
          return { _sum: { amount: sums[where.spentAt.gte.toISOString().slice(0, 10)] ?? null } };
        }),
      },
    };
    const svc = new ExpensesService({ client: db } as never);
    const out = await svc.periodTotals("u1", "2026-10-04");
    expect(out).toMatchObject({ basis: "ACTUAL", date: "2026-10-04", flowType: "EXPENSE", today: "500.00", month: "15420.00", year: "190000.00" });
    expect(seen.sort()).toEqual(["2026-01-01", "2026-10-01", "2026-10-04"]);
    for (const [{ where }] of db.expense.aggregate.mock.calls) {
      expect(where).toMatchObject({ userId: "u1", flowType: "EXPENSE", category: { type: { not: "SAVINGS" } } });
    }
  });
});

