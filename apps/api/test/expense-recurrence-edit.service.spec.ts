import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ExpensesService } from "../src/expenses/expenses.service";
import { ExpenseRecurrenceEditService } from "../src/expenses/expense-recurrence-edit.service";
import { resolveExpenseRule } from "../src/common/recurrence/recurrence-template.util";

// ---------------------------------------------------------------------------------------
// An in-memory Expense table, so these tests check what the HISTORY looks like after each edit
// or delete (the thing that matters), not which Prisma calls were made.
//   t  = the recurrence TEMPLATE (also the first real occurrence, 1 Jul)
//   o1 = generated 1 Aug · o2 = generated 1 Sep · o3 = generated 1 Oct
// ---------------------------------------------------------------------------------------
type Row = Record<string, any>;

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function seed(): Row[] {
  const base = { userId: "u1", categoryId: "c1", merchant: "Netflix", amount: 999, paymentMethod: "UPI", notes: null, flowType: "EXPENSE", currency: "INR" };
  return [
    { ...base, id: "t", spentAt: d("2026-07-01"), recurrence: "MONTHLY", recurrenceActive: true, generatedFromRecurringId: null, recurrenceTemplate: null, recurrenceEndDate: null },
    { ...base, id: "o1", spentAt: d("2026-08-01"), recurrence: null, recurrenceActive: false, generatedFromRecurringId: "t", recurrenceTemplate: null },
    { ...base, id: "o2", spentAt: d("2026-09-01"), recurrence: null, recurrenceActive: false, generatedFromRecurringId: "t", recurrenceTemplate: null },
    { ...base, id: "o3", spentAt: d("2026-10-01"), recurrence: null, recurrenceActive: false, generatedFromRecurringId: "t", recurrenceTemplate: null },
    { ...base, id: "plain", spentAt: d("2026-10-02"), recurrence: null, recurrenceActive: false, generatedFromRecurringId: null, recurrenceTemplate: null },
    { ...base, id: "other-users", userId: "u2", spentAt: d("2026-10-02"), recurrence: null, recurrenceActive: false, generatedFromRecurringId: null, recurrenceTemplate: null },
  ];
}

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === "NOT") return !matches(row, v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("gte" in v) return row[k] >= v.gte;
      return false;
    }
    return row[k] === v;
  });

function build(rows: Row[] = seed(), categoryType = "NEED") {
  const db: any = {
    expense: {
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id)!, strip(data))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, strip(data)));
        return { count: hit.length };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { count: hit.length };
      }),
    },
    category: { findUnique: jest.fn(async () => ({ type: categoryType, name: "Cat" })) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(db));
  const prisma = { client: db } as never;
  const expenses = new ExpensesService(prisma);
  return { rows, db, svc: new ExpenseRecurrenceEditService(prisma, expenses) };
}

const strip = (o: Row) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const get = (rows: Row[], id: string) => rows.find((r) => r.id === id)!;
const amounts = (rows: Row[]) => Object.fromEntries(rows.filter((r) => r.userId === "u1").map((r) => [r.id, Number(r.amount)]));

describe("ExpenseRecurrenceEditService — edit scopes (spec Part 11)", () => {
  it("THIS on a generated occurrence changes only that row; the rule and every other row are untouched", async () => {
    const { rows, svc } = build();
    await svc.update("u1", "o2", { amount: 1500 } as never, "THIS");
    expect(amounts(rows)).toMatchObject({ t: 999, o1: 999, o2: 1500, o3: 999 });
    expect(get(rows, "t").recurrenceTemplate).toBeNull();
    expect(resolveExpenseRule(get(rows, "t")).amount).toBe(999);
  });

  it("scope defaults to THIS (the safe choice)", async () => {
    const { rows, svc } = build();
    await svc.update("u1", "o2", { amount: 1500 } as never);
    expect(amounts(rows)).toMatchObject({ o1: 999, o2: 1500, o3: 999 });
  });

  it("THIS on the TEMPLATE row freezes the rule first, so correcting that one historical record never changes the future", async () => {
    const { rows, svc } = build();
    await svc.update("u1", "t", { amount: 1200 } as never, "THIS"); // typo fix on the first record
    expect(Number(get(rows, "t").amount)).toBe(1200);
    // Future occurrences are still generated with the ORIGINAL 999.
    expect(Number(resolveExpenseRule(get(rows, "t")).amount)).toBe(999);
    expect(amounts(rows)).toMatchObject({ o1: 999, o2: 999, o3: 999 });
  });

  it("FUTURE on an occurrence changes it, every LATER occurrence and the rule — never an earlier row", async () => {
    const { rows, svc } = build();
    await svc.update("u1", "o2", { amount: 1100 } as never, "FUTURE");
    expect(amounts(rows)).toMatchObject({ t: 999, o1: 999, o2: 1100, o3: 1100 });
    expect(Number(resolveExpenseRule(get(rows, "t")).amount)).toBe(1100); // occurrences not yet generated
    expect(get(rows, "o1").spentAt).toEqual(d("2026-08-01")); // dates are never rewritten
  });

  it("FUTURE touches only rule fields on later occurrences (their dates stay)", async () => {
    const { rows, svc } = build();
    await svc.update("u1", "o1", { merchant: "Netflix Premium" } as never, "FUTURE");
    expect(rows.filter((r) => r.generatedFromRecurringId === "t").map((r) => r.merchant)).toEqual(["Netflix Premium", "Netflix Premium", "Netflix Premium"]);
    expect(get(rows, "t").merchant).toBe("Netflix"); // the historical first record keeps its own value
    expect(get(rows, "t").recurrenceTemplate.merchant).toBe("Netflix Premium");
  });

  it("FUTURE on the template applies to the template, all generated rows and the rule", async () => {
    const { rows, svc } = build();
    await svc.update("u1", "t", { amount: 1300 } as never, "FUTURE");
    expect(amounts(rows)).toMatchObject({ t: 1300, o1: 1300, o2: 1300, o3: 1300 });
  });

  it("a date can only change for one occurrence, never in bulk", async () => {
    const { rows, svc } = build();
    await expect(svc.update("u1", "o2", { spentAt: "2026-09-05" } as never, "FUTURE")).rejects.toBeInstanceOf(BadRequestException);
    expect(get(rows, "o2").spentAt).toEqual(d("2026-09-01"));
    await svc.update("u1", "o2", { spentAt: "2026-09-05" } as never, "THIS");
    expect(get(rows, "o2").spentAt).toEqual(d("2026-09-05"));
  });

  it("an edit that doesn't touch rule fields (a date-only fix) leaves the rule alone", async () => {
    const { rows, svc } = build();
    await svc.update("u1", "t", { spentAt: "2026-07-02" } as never, "THIS");
    expect(get(rows, "t").recurrenceTemplate).toBeNull();
  });

  it("still refuses to move an occurrence into a savings/investment category", async () => {
    const { rows, svc } = build(seed(), "SAVINGS");
    await expect(svc.update("u1", "o2", { categoryId: "sip" } as never, "FUTURE")).rejects.toBeInstanceOf(BadRequestException);
    expect(amounts(rows)).toMatchObject({ o2: 999, o3: 999 });
  });

  it("an ordinary (non-recurring) expense uses the original update path; a FUTURE scope makes no sense for it", async () => {
    const { rows, svc } = build();
    await svc.update("u1", "plain", { amount: 50 } as never);
    expect(Number(get(rows, "plain").amount)).toBe(50);
    await expect(svc.update("u1", "plain", { amount: 60 } as never, "FUTURE")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("another user's expense is a 404", async () => {
    const { svc } = build();
    await expect(svc.update("u1", "other-users", { amount: 1 } as never)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ExpenseRecurrenceEditService.updateRule — the rule only", () => {
  it("changes cadence, end date and amount for FUTURE generation without touching any existing expense", async () => {
    const { rows, svc } = build();
    const before = JSON.stringify(rows.map((r) => [r.id, r.amount, r.spentAt, r.merchant]));
    await svc.updateRule("u1", "t", { recurrence: "BIWEEKLY", endDate: "2027-03-31", amount: 1099 } as never);

    expect(get(rows, "t").recurrence).toBe("BIWEEKLY");
    expect(get(rows, "t").recurrenceEndDate).toEqual(d("2027-03-31"));
    expect(Number(resolveExpenseRule(get(rows, "t")).amount)).toBe(1099);
    // Every existing record (including the template's own row) is exactly as it was.
    expect(JSON.stringify(rows.map((r) => [r.id, r.amount, r.spentAt, r.merchant]))).toBe(before);
  });

  it("accepts an occurrence's id and edits its template's rule", async () => {
    const { rows, svc } = build();
    await svc.updateRule("u1", "o3", { recurrence: "QUARTERLY" } as never);
    expect(get(rows, "t").recurrence).toBe("QUARTERLY");
  });

  it("can clear the end date explicitly", async () => {
    const rows = seed();
    get(rows, "t").recurrenceEndDate = d("2027-01-01");
    const { svc } = build(rows);
    await svc.updateRule("u1", "t", { clearEndDate: true } as never);
    expect(get(rows, "t").recurrenceEndDate).toBeNull();
  });

  it.each([
    ["ONE_TIME cadence (use stop instead)", "t", { recurrence: "ONE_TIME" }],
    ["an end date before the first expense", "t", { endDate: "2026-01-01" }],
    ["an empty change", "t", {}],
    ["a non-repeating expense", "plain", { amount: 5 }],
  ])("rejects %s", async (_name, id, dto) => {
    const { svc } = build();
    await expect(svc.updateRule("u1", id as string, dto as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("another user's expense is a 404", async () => {
    const { svc } = build();
    await expect(svc.updateRule("u1", "other-users", { amount: 5 } as never)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ExpenseRecurrenceEditService.remove — history is never destroyed by accident (Part 11 / 52)", () => {
  it("THIS deletes one generated occurrence and nothing else", async () => {
    const { rows, svc } = build();
    await svc.remove("u1", "o2", "THIS");
    expect(rows.map((r) => r.id).filter((id) => id !== "other-users")).toEqual(["t", "o1", "o3", "plain"]);
  });

  it("REFUSES to delete the template of an ACTIVE recurrence (it would silently stop the repeat)", async () => {
    const { rows, svc } = build();
    await expect(svc.remove("u1", "t", "THIS")).rejects.toThrow(/Stop the recurrence first/);
    expect(rows.find((r) => r.id === "t")).toBeDefined();
  });

  it("allows deleting the template once the recurrence has been stopped", async () => {
    const rows = seed();
    get(rows, "t").recurrenceActive = false;
    const { svc } = build(rows);
    await svc.remove("u1", "t", "THIS");
    expect(rows.find((r) => r.id === "t")).toBeUndefined();
    expect(rows.filter((r) => r.generatedFromRecurringId === "t")).toHaveLength(3); // history kept
  });

  it("FUTURE deletes that occurrence and every LATER one, keeping earlier history, the template and the rule", async () => {
    const { rows, svc } = build();
    const out = await svc.remove("u1", "o2", "FUTURE");
    expect(out.deleted).toBe(2);
    expect(rows.map((r) => r.id).filter((id) => id !== "other-users")).toEqual(["t", "o1", "plain"]);
    expect(get(rows, "t").recurrenceActive).toBe(true);
  });

  it("FUTURE is only for auto-generated occurrences", async () => {
    const { rows, svc } = build();
    await expect(svc.remove("u1", "t", "FUTURE")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.remove("u1", "plain", "FUTURE")).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(6);
  });

  it("an ordinary expense is deleted exactly as before", async () => {
    const { rows, svc } = build();
    await svc.remove("u1", "plain");
    expect(rows.find((r) => r.id === "plain")).toBeUndefined();
  });

  it("another user's expense is a 404 and nothing is deleted", async () => {
    const { rows, svc } = build();
    await expect(svc.remove("u1", "other-users")).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(6);
  });
});
