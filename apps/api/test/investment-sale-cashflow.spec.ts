import { BadRequestException } from "@nestjs/common";
import { InvestmentsService } from "../src/investments/investments.service";

describe("InvestmentsService.recordSale — the sale's tax record and its cash effect", () => {
  const investment = { id: "i1", userId: "u1", type: "MUTUAL_FUND", costBasis: 100000, purchaseDate: new Date("2024-01-10T00:00:00Z") };
  const dto = (over: Record<string, unknown> = {}) => ({ saleDate: "2026-09-15", proceeds: 60000, costBasisPortion: 40000, ...over }) as never;

  const build = () => {
    const events: any[] = [];
    const cashflows: any[] = [];
    const db: any = {
      investment: { findUnique: jest.fn().mockResolvedValue(investment) },
      realizedGainEvent: { create: jest.fn(async ({ data }: any) => { const e = { id: `ev${events.length + 1}`, ...data }; events.push(e); return e; }) },
      investmentCashflow: { create: jest.fn(async ({ data }: any) => { cashflows.push(data); return data; }) },
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(db));
    return { db, events, cashflows, svc: new InvestmentsService({ client: db } as never) };
  };

  it("by default records the tax event ONLY — cash is untouched and no transaction is needed (original behaviour)", async () => {
    const { db, events, cashflows, svc } = build();
    const out: any = await svc.recordSale("u1", "i1", dto());
    expect(out).toMatchObject({ proceeds: 60000, costBasisPortion: 40000, gainAmount: 20000, gainCategory: expect.any(String) });
    expect(events).toHaveLength(1);
    expect(cashflows).toHaveLength(0);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("with alsoRecordCashflow it records the tax event AND a SALE cashflow of the proceeds, in one transaction", async () => {
    const { db, events, cashflows, svc } = build();
    await svc.recordSale("u1", "i1", dto({ alsoRecordCashflow: true, notes: "Rebalancing" }));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(cashflows).toEqual([
      expect.objectContaining({
        userId: "u1",
        investmentId: "i1",
        type: "SALE",
        amount: 60000, // the full proceeds reach cash — the gain is not what is deposited
        occurredAt: new Date("2026-09-15"),
        periodKey: "sale:ev1", // tied to the event: at most one cash entry per sale
        origin: "MANUAL",
      }),
    ]);
  });

  it("if the cashflow cannot be written the whole sale fails — no half-recorded sale", async () => {
    const { db, svc } = build();
    db.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => {
      const tx = { ...db, investmentCashflow: { create: jest.fn().mockRejectedValue(new Error("db down")) } };
      return fn(tx); // a rejection inside the callback aborts (rolls back) the transaction
    });
    await expect(svc.recordSale("u1", "i1", dto({ alsoRecordCashflow: true }))).rejects.toThrow("db down");
  });

  it("validation still happens before anything is written (cost basis cannot exceed what was invested)", async () => {
    const { db, events, cashflows, svc } = build();
    await expect(svc.recordSale("u1", "i1", dto({ costBasisPortion: 999999, alsoRecordCashflow: true }))).rejects.toBeInstanceOf(BadRequestException);
    expect(events).toHaveLength(0);
    expect(cashflows).toHaveLength(0);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
