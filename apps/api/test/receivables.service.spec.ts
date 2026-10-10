import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ReceivablesService } from "../src/receivables/receivables.service";

// ---------------------------------------------------------------------------------------
// A small in-memory stand-in for the two receivable tables, so the tests exercise the real
// derive-from-ledger behavior (status, outstanding, idempotency) rather than call counts.
// There is deliberately NO `expense` table on this fake: any code path that tried to record
// an expense for a receivable would throw, which is the Part 57 "expense unchanged" guarantee.
// ---------------------------------------------------------------------------------------
type Row = Record<string, any>;

function makeDb() {
  const receivables: Row[] = [];
  const repayments: Row[] = [];
  let seq = 0;
  const nid = (p: string) => `${p}${++seq}`;

  const statusMatches = (status: string, f: any): boolean => {
    if (!f) return true;
    if (f.in) return f.in.includes(status);
    if (f.not !== undefined) return status !== f.not;
    if (f.equals !== undefined) return status === f.equals;
    return true;
  };

  const repaymentFilter = (w: any) => (r: Row) =>
    (w.receivableId === undefined ||
      (typeof w.receivableId === "string" ? r.receivableId === w.receivableId : w.receivableId.in.includes(r.receivableId))) &&
    (w.userId === undefined || r.userId === w.userId) &&
    (w.id === undefined || r.id === w.id) &&
    (w.idempotencyKey === undefined || r.idempotencyKey === w.idempotencyKey) &&
    (!w.returnedAt || ((!w.returnedAt.gte || r.returnedAt >= w.returnedAt.gte) && (!w.returnedAt.lt || r.returnedAt < w.returnedAt.lt)));

  const sum = (rows: Row[]) => rows.reduce((a, r) => a + Number(r.amount), 0);

  const db: any = {
    receivable: {
      findFirst: jest.fn(async ({ where }: any) => receivables.find((r) => r.id === where.id && r.userId === where.userId) ?? null),
      findMany: jest.fn(async ({ where }: any) => receivables.filter((r) => r.userId === where.userId && statusMatches(r.status, where.status))),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: nid("r"), currency: "INR", status: "OUTSTANDING", paymentMethod: "UPI", cancelledAt: null, purpose: null, notes: null, expectedReturnAt: null, createdAt: new Date(), updatedAt: new Date(), ...stripUndefined(data) };
        receivables.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(receivables.find((r) => r.id === where.id)!, stripUndefined(data))),
      delete: jest.fn(async ({ where }: any) => {
        receivables.splice(receivables.findIndex((r) => r.id === where.id), 1);
      }),
    },
    receivableRepayment: {
      findFirst: jest.fn(async ({ where }: any) => repayments.find(repaymentFilter(where)) ?? null),
      findMany: jest.fn(async ({ where }: any) => repayments.filter(repaymentFilter(where))),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: nid("p"), paymentMethod: "UPI", idempotencyKey: null, notes: null, createdAt: new Date(), ...stripUndefined(data) };
        repayments.push(row);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        repayments.splice(repayments.findIndex((r) => r.id === where.id), 1);
      }),
      count: jest.fn(async ({ where }: any) => repayments.filter(repaymentFilter(where)).length),
      aggregate: jest.fn(async ({ where }: any) => {
        const rows = repayments.filter(repaymentFilter(where));
        return {
          _sum: { amount: rows.length ? sum(rows) : null },
          _min: { returnedAt: rows.length ? new Date(Math.min(...rows.map((r) => r.returnedAt.getTime()))) : null },
        };
      }),
      groupBy: jest.fn(async ({ where }: any) => {
        const out = new Map<string, number>();
        for (const r of repayments.filter(repaymentFilter(where))) out.set(r.receivableId, (out.get(r.receivableId) ?? 0) + Number(r.amount));
        return [...out.entries()].map(([receivableId, amount]) => ({ receivableId, _sum: { amount } }));
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(db));
  return { db, receivables, repayments };
}

function stripUndefined(o: Row) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

describe("ReceivablesService", () => {
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const build = () => {
    const fake = makeDb();
    return { ...fake, svc: new ReceivablesService({ client: fake.db } as never, audit as never) };
  };
  const give = (svc: ReceivablesService, amount = 5000, extra: Record<string, unknown> = {}) =>
    svc.create("u1", { person: "Friend", amount, givenAt: iso(-30), ...extra } as never);

  beforeEach(() => jest.clearAllMocks());

  it("Part 57: ₹5,000 given → ₹2,000 back → ₹3,000 back, derived from the repayment ledger", async () => {
    const { svc } = build();
    const created = await give(svc);
    expect(created).toMatchObject({ originalAmount: "5000.00", returnedAmount: "0.00", outstandingAmount: "5000.00", status: "OUTSTANDING" });

    const first = await svc.recordRepayment("u1", created.id, { amount: 2000, returnedAt: iso(-10) } as never);
    expect(first.receivable).toMatchObject({ returnedAmount: "2000.00", outstandingAmount: "3000.00", status: "PARTIALLY_RETURNED" });
    expect((await svc.summary("u1")).totalOutstanding).toBe("3000.00");

    const second = await svc.recordRepayment("u1", created.id, { amount: 3000, returnedAt: iso(-5) } as never);
    expect(second.receivable).toMatchObject({ returnedAmount: "5000.00", outstandingAmount: "0.00", status: "FULLY_RETURNED" });
    expect(second.receivable.repayments).toHaveLength(2);
    expect((await svc.summary("u1")).totalOutstanding).toBe("0.00");
  });

  it("rejects a repayment larger than what is outstanding and records nothing", async () => {
    const { svc, repayments } = build();
    const r = await give(svc);
    await svc.recordRepayment("u1", r.id, { amount: 2000, returnedAt: iso(-10) } as never);
    await expect(svc.recordRepayment("u1", r.id, { amount: 3500, returnedAt: iso(-5) } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(repayments).toHaveLength(1);
  });

  it("a double-submitted repayment with the same idempotencyKey records exactly one", async () => {
    const { svc, repayments } = build();
    const r = await give(svc);
    const body = { amount: 1000, returnedAt: iso(-5), idempotencyKey: "form-submit-0001" } as never;
    const a = await svc.recordRepayment("u1", r.id, body);
    const b = await svc.recordRepayment("u1", r.id, body);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.repayment.id).toBe(a.repayment.id);
    expect(repayments).toHaveLength(1);
    expect(b.receivable.returnedAmount).toBe("1000.00");
  });

  it("rejects a repayment dated before the money was given, and future-dated ones", async () => {
    const { svc } = build();
    const r = await give(svc);
    await expect(svc.recordRepayment("u1", r.id, { amount: 100, returnedAt: iso(-40) } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.recordRepayment("u1", r.id, { amount: 100, returnedAt: iso(10) } as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("takes the per-receivable advisory lock inside the transaction before reading the balance", async () => {
    const { svc, db } = build();
    const r = await give(svc);
    db.$queryRaw.mockClear();
    await svc.recordRepayment("u1", r.id, { amount: 100, returnedAt: iso(-5) } as never);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("another user's receivable is a 404 for every operation", async () => {
    const { svc } = build();
    const r = await give(svc);
    await expect(svc.get("intruder", r.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.recordRepayment("intruder", r.id, { amount: 1, returnedAt: iso(-1) } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.cancel("intruder", r.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove("intruder", r.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe("cancel / delete never erase repayment history", () => {
    it("cancelling an entry with no repayments voids it: excluded from totals, listed only under CANCELLED", async () => {
      const { svc } = build();
      const r = await give(svc);
      const cancelled = await svc.cancel("u1", r.id);
      expect(cancelled).toMatchObject({ status: "CANCELLED", outstandingAmount: "0.00" });
      expect((await svc.summary("u1")).totalOutstanding).toBe("0.00");
      expect(await svc.list("u1", {})).toHaveLength(0);
      expect(await svc.list("u1", { scope: "CANCELLED" })).toHaveLength(1);
      await expect(svc.recordRepayment("u1", r.id, { amount: 1, returnedAt: iso(-1) } as never)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to cancel or delete once a repayment exists", async () => {
      const { svc } = build();
      const r = await give(svc);
      await svc.recordRepayment("u1", r.id, { amount: 500, returnedAt: iso(-5) } as never);
      await expect(svc.cancel("u1", r.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.remove("u1", r.id)).rejects.toBeInstanceOf(BadRequestException);
      expect((await svc.get("u1", r.id)).repayments).toHaveLength(1);
    });

    it("hard-deletes an entry that has no history", async () => {
      const { svc, receivables } = build();
      const r = await give(svc);
      await expect(svc.remove("u1", r.id)).resolves.toEqual({ deleted: true });
      expect(receivables).toHaveLength(0);
    });

    it("deleting one mistaken repayment re-derives the status", async () => {
      const { svc } = build();
      const r = await give(svc);
      const rep = await svc.recordRepayment("u1", r.id, { amount: 5000, returnedAt: iso(-5) } as never);
      expect(rep.receivable.status).toBe("FULLY_RETURNED");
      const after = await svc.removeRepayment("u1", r.id, rep.repayment.id);
      expect(after).toMatchObject({ status: "OUTSTANDING", outstandingAmount: "5000.00" });
    });
  });

  describe("update", () => {
    it("cannot lower the amount below what has already been returned", async () => {
      const { svc } = build();
      const r = await give(svc);
      await svc.recordRepayment("u1", r.id, { amount: 3000, returnedAt: iso(-5) } as never);
      await expect(svc.update("u1", r.id, { amount: 2000 } as never)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("raising the amount on a fully returned receivable re-opens it as partially returned", async () => {
      const { svc } = build();
      const r = await give(svc);
      await svc.recordRepayment("u1", r.id, { amount: 5000, returnedAt: iso(-5) } as never);
      const updated = await svc.update("u1", r.id, { amount: 6000 } as never);
      expect(updated).toMatchObject({ status: "PARTIALLY_RETURNED", outstandingAmount: "1000.00" });
    });

    it("cannot move givenAt after the first repayment, nor expectedReturnAt before givenAt", async () => {
      const { svc } = build();
      const r = await give(svc);
      await svc.recordRepayment("u1", r.id, { amount: 100, returnedAt: iso(-20) } as never);
      await expect(svc.update("u1", r.id, { givenAt: iso(-10) } as never)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.update("u1", r.id, { expectedReturnAt: iso(-60) } as never)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("summary buckets", () => {
    it("splits outstanding into overdue / due soon / later and finds the largest", async () => {
      const { svc } = build();
      await give(svc, 1000, { person: "Overdue Pal", expectedReturnAt: iso(-3) });
      await give(svc, 2000, { person: "Soon Pal", expectedReturnAt: iso(3) });
      await give(svc, 4000, { person: "Later Pal", expectedReturnAt: iso(40) });
      const returned = await give(svc, 900, { person: "Paid Pal" });
      await svc.recordRepayment("u1", returned.id, { amount: 900, returnedAt: iso(-1) } as never);

      const s = await svc.summary("u1");
      expect(s.totalOutstanding).toBe("7000.00");
      expect(s.activeCount).toBe(3);
      expect(s.overdue).toEqual({ amount: "1000.00", count: 1 });
      expect(s.dueSoon).toMatchObject({ amount: "2000.00", count: 1, withinDays: 7 });
      expect(s.largest).toMatchObject({ person: "Later Pal", outstandingAmount: "4000.00" });
      expect(s.returnedThisMonth).toBeDefined();
    });

    it("exposes OVERDUE as effectiveStatus without persisting it", async () => {
      const { svc, receivables } = build();
      const r = await give(svc, 1000, { expectedReturnAt: iso(-3) });
      expect(r).toMatchObject({ status: "OUTSTANDING", effectiveStatus: "OVERDUE" });
      expect(receivables[0].status).toBe("OUTSTANDING");
      expect(r.daysUntilDue).toBeLessThan(0);
    });
  });
});
