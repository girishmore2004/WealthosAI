jest.mock("../src/common/financial-facts/financial-facts.service", () => ({ FinancialFactsService: class {} }));

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ExpensesService } from "../src/expenses/expenses.service";
import { EmergencyFundService } from "../src/financial-core/emergency-fund/emergency-fund.service";
import { InvestmentLedgerService } from "../src/investments/investment-ledger.service";
import { RecurrenceGeneratorService } from "../src/common/recurrence/recurrence-generator.service";

const p2002 = () => Object.assign(new Error("unique"), { code: "P2002" });

// ---------------------------------------------------------------------------------------
// Batch 1 correctness fixes: each block pins one of the audit's double-count / integrity
// findings so it cannot silently regress.
// ---------------------------------------------------------------------------------------

describe("ExpensesService.update — the SAVINGS guard cannot be bypassed by editing", () => {
  const build = () => {
    const db = {
      category: { findUnique: jest.fn() },
      expense: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn().mockResolvedValue({ id: "e1" }) },
    };
    return { db, svc: new ExpensesService({ client: db } as never) };
  };

  it("rejects moving an existing expense into a SAVINGS category and writes nothing", async () => {
    const { db, svc } = build();
    db.category.findUnique.mockResolvedValue({ type: "SAVINGS", name: "SIP Investment" });
    await expect(svc.update("u1", "e1", { categoryId: "c-sip" } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.expense.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown category with a clear 400", async () => {
    const { db, svc } = build();
    db.category.findUnique.mockResolvedValue(null);
    await expect(svc.update("u1", "e1", { categoryId: "nope" } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.expense.updateMany).not.toHaveBeenCalled();
  });

  it("allows moving to a NEED/WANT category", async () => {
    const { db, svc } = build();
    db.category.findUnique.mockResolvedValue({ type: "WANT", name: "Dining" });
    await expect(svc.update("u1", "e1", { categoryId: "c-dining" } as never)).resolves.toEqual({ id: "e1" });
    expect(db.expense.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not query categories for edits that leave the category alone", async () => {
    const { db, svc } = build();
    await svc.update("u1", "e1", { merchant: "New name" } as never);
    expect(db.category.findUnique).not.toHaveBeenCalled();
  });
});

describe("EmergencyFundService.remove — the reserve can never go negative", () => {
  const build = (rows: Array<{ type: string; _sum: { amount: unknown } }>, entry: object | null) => {
    const db = {
      emergencyFundEntry: {
        groupBy: jest.fn().mockResolvedValue(rows),
        findFirst: jest.fn().mockResolvedValue(entry),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
    return { db, svc: new EmergencyFundService({ client: db } as never, {} as never) };
  };

  it("blocks deleting an allocation that later withdrawals depend on (₹7,000 in, ₹3,000 used)", async () => {
    // Balance is 7,000 − 3,000 = 4,000; deleting the 7,000 allocation would leave −3,000.
    const { db, svc } = build(
      [{ type: "ALLOCATE", _sum: { amount: 7000 } }, { type: "WITHDRAWAL", _sum: { amount: 3000 } }],
      { id: "a1", type: "ALLOCATE", amount: 7000 },
    );
    await expect(svc.remove("u1", "a1")).rejects.toBeInstanceOf(BadRequestException);
    expect(db.emergencyFundEntry.deleteMany).not.toHaveBeenCalled();
  });

  it("allows deleting an allocation the remaining balance can absorb", async () => {
    const { db, svc } = build([{ type: "ALLOCATE", _sum: { amount: 10000 } }], { id: "a2", type: "ALLOCATE", amount: 4000 });
    await expect(svc.remove("u1", "a2")).resolves.toEqual({ deleted: true });
    expect(db.emergencyFundEntry.deleteMany).toHaveBeenCalledWith({ where: { id: "a2", userId: "u1" } });
  });

  it("always allows deleting a withdrawal (it can only raise the balance)", async () => {
    const { svc } = build([{ type: "WITHDRAWAL", _sum: { amount: 500 } }], { id: "w1", type: "WITHDRAWAL", amount: 500 });
    await expect(svc.remove("u1", "w1")).resolves.toEqual({ deleted: true });
  });

  it("takes the per-user advisory lock before reading the balance", async () => {
    const { db, svc } = build([{ type: "ALLOCATE", _sum: { amount: 100 } }], { id: "a3", type: "ALLOCATE", amount: 50 });
    await svc.remove("u1", "a3");
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.emergencyFundEntry.groupBy.mock.invocationCallOrder[0]);
  });

  it("a foreign/missing entry is a 404", async () => {
    const { svc } = build([], null);
    await expect(svc.remove("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("withdrawal check and insert share one transaction (no overdraw between read and write)", async () => {
    const { db, svc } = build([{ type: "ALLOCATE", _sum: { amount: 3000 } }], null);
    await expect(
      svc.create("u1", { type: "WITHDRAWAL", amount: 3500, occurredAt: "2026-09-01T00:00:00Z" } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.emergencyFundEntry.create).not.toHaveBeenCalled();
  });
});

describe("InvestmentLedgerService.addValuation — write-through to the legacy currentValue", () => {
  const build = () => {
    const db = {
      investment: { findFirst: jest.fn().mockResolvedValue({ id: "i1", type: "MUTUAL_FUND" }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      investmentValuation: { upsert: jest.fn(), findFirst: jest.fn() },
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
    return { db, svc: new InvestmentLedgerService({ client: db } as never, {} as never) };
  };
  const dto = (value: number, valuedAt = "2026-10-01T00:00:00Z") => ({ value, valuedAt }) as never;

  it("₹10,000 contributed then valued at ₹10,500: currentValue becomes 10,500 (gain is a valuation, not a contribution)", async () => {
    const { db, svc } = build();
    db.investmentValuation.upsert.mockResolvedValue({ id: "v1", value: 10500 });
    db.investmentValuation.findFirst.mockResolvedValue({ id: "v1", value: 10500 });
    await svc.addValuation("u1", "i1", dto(10500));
    expect(db.investment.updateMany).toHaveBeenCalledWith({ where: { id: "i1", userId: "u1" }, data: { currentValue: 10500 } });
  });

  it("a back-dated valuation older than the latest one does not roll currentValue backwards", async () => {
    const { db, svc } = build();
    db.investmentValuation.upsert.mockResolvedValue({ id: "old", value: 9000 });
    db.investmentValuation.findFirst.mockResolvedValue({ id: "newer", value: 11000 });
    await svc.addValuation("u1", "i1", dto(9000, "2026-01-01T00:00:00Z"));
    expect(db.investment.updateMany).not.toHaveBeenCalled();
  });

  it("never writes a cashflow: a valuation is not a contribution", async () => {
    const { db, svc } = build();
    (db as Record<string, unknown>).investmentCashflow = { create: jest.fn() };
    db.investmentValuation.upsert.mockResolvedValue({ id: "v1", value: 10500 });
    db.investmentValuation.findFirst.mockResolvedValue({ id: "v1", value: 10500 });
    await svc.addValuation("u1", "i1", dto(10500));
    expect(((db as unknown) as { investmentCashflow: { create: jest.Mock } }).investmentCashflow.create).not.toHaveBeenCalled();
  });
});

describe("RecurrenceGeneratorService — row and idempotency log commit atomically", () => {
  const build = () => {
    const client = {
      income: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() },
      expense: { findMany: jest.fn(), create: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      recurringEventLog: { create: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    client.$transaction.mockImplementation(async (fn: (tx: typeof client) => Promise<unknown>) => fn(client));
    return { client, svc: new RecurrenceGeneratorService({ client } as never) };
  };
  const template = {
    id: "e1", userId: "u1", categoryId: "c1", merchant: "Gym", amount: 1500, currency: "INR", paymentMethod: "UPI",
    notes: null, recurrence: "MONTHLY", spentAt: new Date("2026-08-01T00:00:00Z"), nextOccurrenceAt: new Date("2026-08-01T00:00:00Z"),
    recurrenceEndDate: new Date("2026-09-15T00:00:00Z"), recurrenceActive: true,
  };

  it("writes the expense and its log entry inside a single transaction", async () => {
    const { client, svc } = build();
    client.expense.findMany.mockResolvedValue([template]);
    client.expense.create.mockResolvedValue({ id: "gen1" });
    client.recurringEventLog.create.mockResolvedValue({});
    const out = await svc.generateForUser("u1");
    expect(out.find((s) => s.sourceId === "e1")?.generated).toBe(1); // only 2026-09-01 falls before the end date
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(client.recurringEventLog.create.mock.calls[0][0].data).toMatchObject({ sourceType: "EXPENSE", sourceId: "e1", generatedRecordId: "gen1" });
  });

  it("when the log insert loses the idempotency race, the occurrence is skipped (the transaction rolls the expense back)", async () => {
    const { client, svc } = build();
    client.expense.findMany.mockResolvedValue([template]);
    client.expense.create.mockResolvedValue({ id: "gen1" });
    client.recurringEventLog.create.mockRejectedValue(p2002());
    const out = await svc.generateForUser("u1");
    expect(out.find((s) => s.sourceId === "e1")?.generated).toBe(0);
    expect(client.auditLog.create).not.toHaveBeenCalled();
  });
});
