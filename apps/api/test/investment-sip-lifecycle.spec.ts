jest.mock("../src/common/financial-facts/financial-facts.service", () => ({ FinancialFactsService: class {} }));

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { InvestmentLedgerService } from "../src/investments/investment-ledger.service";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
type Row = Record<string, any>;

// A small in-memory store with just enough query semantics for the ledger service.
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR" || k === "investment") return true; // relation / text search handled by the real database
    if (v === null) return row[k] === null || row[k] === undefined;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("gte" in v && !(row[k] >= v.gte)) return false;
      if ("lt" in v && !(row[k] < v.lt)) return false;
      if ("lte" in v && !(row[k] <= v.lte)) return false;
      return true;
    }
    if (v instanceof Date) return row[k]?.getTime() === v.getTime();
    return row[k] === v || (typeof row[k] === "object" && row[k] !== null && Number(row[k]) === Number(v));
  });
}

function build(inv: Row = {}, userId = "u1") {
  const investment: Row = {
    id: "i1", userId, name: "Nifty 50 Index Fund", type: "MUTUAL_FUND", monthlyContribution: null, contributionDay: null, contributionFrequency: "MONTHLY",
    contributionStartDate: null, contributionEndDate: null, sipActive: false, sipPausedAt: null, sipCancelledAt: null, expectedAnnualReturn: null, ...inv,
  };
  const cashflows: Row[] = [];
  const events: Row[] = [];
  const changes: Row[] = [];
  const audit = jest.fn(async () => undefined);
  let seq = 0;
  const dbx: any = {
    investment: {
      findFirst: jest.fn(async ({ where }: any) => (matches(investment, where) ? investment : null)),
      update: jest.fn(async ({ data }: any) => Object.assign(investment, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)))),
    },
    investmentCashflow: {
      findFirst: jest.fn(async ({ where }: any) => cashflows.find((r) => matches(r, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) => cashflows.filter((r) => matches(r, where))),
      count: jest.fn(async ({ where }: any) => cashflows.filter((r) => matches(r, where)).length),
      groupBy: jest.fn(async () => []),
      aggregate: jest.fn(async ({ where }: any) => {
        const rows = cashflows.filter((r) => matches(r, where));
        return { _max: { occurredAt: rows.length ? new Date(Math.max(...rows.map((r) => r.occurredAt.getTime()))) : null }, _sum: { amount: rows.reduce((a, r) => a + Number(r.amount), 0) }, _count: { _all: rows.length } };
      }),
      create: jest.fn(async ({ data }: any) => {
        if (data.periodKey && cashflows.some((r) => r.periodKey === data.periodKey && r.type === data.type && r.investmentId === data.investmentId)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = { id: `cf${++seq}`, ...data };
        cashflows.push(row);
        return row;
      }),
      // Replaces the stored row with a new object (as a real database round-trip would), so a row read
      // before the update still shows its old values.
      update: jest.fn(async ({ where, data }: any) => {
        const i = cashflows.findIndex((r) => r.id === where.id);
        cashflows[i] = { ...cashflows[i], ...data };
        return cashflows[i];
      }),
    },
    sipInstallmentEvent: {
      findMany: jest.fn(async ({ where }: any) => events.filter((r) => matches(r, where))),
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const row of data) if (!events.some((e) => e.periodKey === row.periodKey)) { events.push({ id: `ev${++seq}`, ...row }); count++; }
        return { count };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const found = events.find((e) => e.periodKey === where.investmentId_periodKey.periodKey);
        if (found) return Object.assign(found, update);
        const row = { id: `ev${++seq}`, ...create };
        events.push(row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        for (let i = events.length - 1; i >= 0; i--) if (matches(events[i], where)) events.splice(i, 1);
        return { count: 0 };
      }),
    },
    investmentSipChange: {
      create: jest.fn(async ({ data }: any) => { const row = { id: `ch${++seq}`, ...data }; changes.push(row); return row; }),
      findMany: jest.fn(async ({ where }: any) => changes.filter((r) => matches(r, where)).sort((a, b) => a.effectiveFrom - b.effectiveFrom)),
    },
    $transaction: jest.fn(async (cb: any) => cb(dbx)),
  };
  const svc = new InvestmentLedgerService({ client: dbx } as never, {} as never, { log: audit } as never);
  return { svc, investment, cashflows, events, changes, audit, db: dbx };
}

const setNow = (iso: string) => jest.useFakeTimers({ now: d(iso), doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "clearImmediate", "performance", "queueMicrotask"] });
afterEach(() => jest.useRealTimers());

const activeSip = { sipActive: true, monthlyContribution: 5000, contributionDay: 5, contributionFrequency: "MONTHLY", contributionStartDate: d("2026-01-05") };

describe("SIP pause / resume / cancel", () => {
  it("pausing stops generation, and resuming never back-fills what fell due while paused", async () => {
    setNow("2026-07-31");
    const { svc, cashflows, events, investment } = build(activeSip);
    await svc.generateSipContributions("u1", "i1", new Date());
    expect(cashflows.map((c) => c.periodKey)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);

    setNow("2026-08-10");
    const paused = await svc.pauseSip("u1", "i1");
    expect(paused.status).toBe("PAUSED");
    expect(investment.sipActive).toBe(false);
    expect((await svc.generateSipContributions("u1", "i1", new Date())).created).toEqual([]);

    setNow("2026-10-10");
    const resumed = await svc.resumeSip("u1", "i1");
    expect(resumed.status).toBe("ACTIVE");
    expect(events.map((e) => [e.periodKey, e.status])).toEqual([["2026-09", "SKIPPED"], ["2026-10", "SKIPPED"]]);

    const out = await svc.generateSipContributions("u1", "i1", new Date());
    expect(out.created).toEqual(["2026-08"]); // due while still active; never recorded
    expect(out.held).toEqual(["2026-09", "2026-10"]); // paused: held, not invented
    expect(cashflows.some((c) => c.periodKey === "2026-09" || c.periodKey === "2026-10")).toBe(false);
  });

  it("cancelling keeps recorded contributions, ends the schedule, and cannot be resumed", async () => {
    setNow("2026-07-31");
    const { svc, cashflows, investment } = build(activeSip);
    await svc.generateSipContributions("u1", "i1", new Date());
    const before = cashflows.length;

    setNow("2026-08-10");
    const out = await svc.cancelSip("u1", "i1");
    expect(out.status).toBe("CANCELLED");
    expect(cashflows).toHaveLength(before);
    expect(investment.contributionEndDate.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    await expect(svc.resumeSip("u1", "i1")).rejects.toThrow(/cancelled/i);
    await expect(svc.cancelSip("u1", "i1")).rejects.toThrow(/already cancelled/i);
    await expect(svc.pauseSip("u1", "i1")).rejects.toThrow(BadRequestException);
  });

  it("refuses lifecycle actions when there is no schedule or it is in the wrong state", async () => {
    setNow("2026-08-10");
    const none = build({});
    await expect(none.svc.pauseSip("u1", "i1")).rejects.toThrow(/no recurring schedule/i);
    const active = build(activeSip);
    await expect(active.svc.resumeSip("u1", "i1")).rejects.toThrow(/already active/i);
  });

  it("another user's investment is a 404 for every action", async () => {
    const { svc } = build(activeSip, "someone-else");
    await expect(svc.pauseSip("u1", "i1")).rejects.toThrow(NotFoundException);
    await expect(svc.cancelSip("u1", "i1")).rejects.toThrow(NotFoundException);
    await expect(svc.listSipInstallments("u1", "i1")).rejects.toThrow(NotFoundException);
    await expect(svc.addCashflow("u1", "i1", { type: "CONTRIBUTION", amount: 1, occurredAt: "2026-01-01" } as never)).rejects.toThrow(NotFoundException);
  });
});

describe("SIP instalments: skipped, failed and confirmed", () => {
  it("a failed or skipped instalment is remembered but never counted as invested, and the schedule leaves it alone", async () => {
    setNow("2026-10-10");
    const { svc, cashflows } = build({ ...activeSip, contributionStartDate: d("2026-08-05") });
    await svc.recordSipInstallment("u1", "i1", { periodKey: "2026-08", status: "FAILED", notes: "mandate bounced" } as never);
    await svc.recordSipInstallment("u1", "i1", { periodKey: "2026-09", status: "SKIPPED" } as never);

    const out = await svc.generateSipContributions("u1", "i1", new Date());
    expect(out.created).toEqual(["2026-10"]);
    expect(out.held).toEqual(["2026-08", "2026-09"]);
    expect(cashflows.map((c) => c.periodKey)).toEqual(["2026-10"]);

    const list = await svc.listSipInstallments("u1", "i1");
    expect(list.map((i) => [i.periodKey, i.state])).toEqual([["2026-11", "UPCOMING"], ["2026-10", "RECORDED"], ["2026-09", "SKIPPED"], ["2026-08", "FAILED"]]);
    expect((await svc.getSipSchedule("u1", "i1")).actualAmount).toBe("5000.00"); // only the recorded one
  });

  it("confirming a held instalment records the contribution once, and clears the held marker", async () => {
    setNow("2026-10-10");
    const { svc, cashflows, events } = build({ ...activeSip, contributionStartDate: d("2026-09-05") });
    await svc.recordSipInstallment("u1", "i1", { periodKey: "2026-09", status: "PENDING" } as never);
    const done = await svc.recordSipInstallment("u1", "i1", { periodKey: "2026-09", status: "CONFIRMED" } as never);
    expect(done.cashflowId).toBeTruthy();
    expect(events).toHaveLength(0);
    expect(cashflows).toHaveLength(1);
    expect(cashflows[0]).toMatchObject({ type: "CONTRIBUTION", periodKey: "2026-09", amount: 5000 });
    await expect(svc.recordSipInstallment("u1", "i1", { periodKey: "2026-09", status: "CONFIRMED" } as never)).rejects.toThrow(ConflictException);
    await expect(svc.recordSipInstallment("u1", "i1", { periodKey: "2026-09", status: "SKIPPED" } as never)).rejects.toThrow(ConflictException);
    expect(cashflows).toHaveLength(1);
  });

  it("a manual contribution in the same period also blocks a second confirmation (no double count)", async () => {
    setNow("2026-10-10");
    const { svc, cashflows } = build({ ...activeSip, contributionStartDate: d("2026-09-05") });
    cashflows.push({ id: "m", investmentId: "i1", userId: "u1", type: "CONTRIBUTION", periodKey: null, origin: "MANUAL", amount: 5000, occurredAt: d("2026-09-07") });
    await expect(svc.recordSipInstallment("u1", "i1", { periodKey: "2026-09", status: "CONFIRMED" } as never)).rejects.toThrow(ConflictException);
  });

  it("rejects a period that is not a due instalment (future, or not on the schedule)", async () => {
    setNow("2026-10-10");
    const { svc } = build(activeSip);
    await expect(svc.recordSipInstallment("u1", "i1", { periodKey: "2026-12", status: "CONFIRMED" } as never)).rejects.toThrow(/not a due instalment/i);
    await expect(svc.recordSipInstallment("u1", "i1", { periodKey: "2025-12", status: "SKIPPED" } as never)).rejects.toThrow(BadRequestException);
  });
});

describe("step-up keeps the past as it was", () => {
  it("contributions before the effective date keep the old amount; later ones use the new amount", async () => {
    setNow("2026-10-10");
    const { svc, cashflows, changes } = build({});
    await svc.setSipSchedule("u1", "i1", { monthlyContribution: 5000, startDate: "2026-01-05", active: true, confirmBackfill: true } as never);
    await svc.setSipSchedule("u1", "i1", { monthlyContribution: 7000, startDate: "2026-01-05", active: true, confirmBackfill: true, effectiveFrom: "2026-09-01" } as never);
    expect(changes.map((c) => c.reason)).toEqual(["CREATED", "STEP_UP"]);

    await svc.generateSipContributions("u1", "i1", new Date());
    const byKey = Object.fromEntries(cashflows.map((c) => [c.periodKey, Number(c.amount)]));
    expect(byKey["2026-01"]).toBe(5000);
    expect(byKey["2026-08"]).toBe(5000);
    expect(byKey["2026-09"]).toBe(7000);
    expect(byKey["2026-10"]).toBe(7000);

    const history = await svc.listSipChanges("u1", "i1");
    expect(history.map((h) => h.reason).sort()).toEqual(["CREATED", "STEP_UP"]);
  });

  it("re-saving the same amount adds no history row", async () => {
    setNow("2026-10-10");
    const { svc, changes } = build({});
    const dto = { monthlyContribution: 5000, startDate: "2026-10-05", active: true } as never;
    await svc.setSipSchedule("u1", "i1", dto);
    await svc.setSipSchedule("u1", "i1", dto);
    expect(changes).toHaveLength(1);
  });

  it("re-activating through the schedule form does not back-fill the paused months either", async () => {
    setNow("2026-07-31");
    const { svc, cashflows, events } = build(activeSip);
    await svc.generateSipContributions("u1", "i1", new Date());
    setNow("2026-08-10");
    await svc.pauseSip("u1", "i1");
    setNow("2026-10-10");
    await svc.setSipSchedule("u1", "i1", { monthlyContribution: 5000, startDate: "2026-01-05", contributionDay: 5, active: true, confirmBackfill: true } as never);
    expect(events.map((e) => e.periodKey)).toEqual(["2026-09", "2026-10"]);
    await svc.generateSipContributions("u1", "i1", new Date());
    expect(cashflows.some((c) => c.periodKey === "2026-09")).toBe(false);
  });
});

describe("transactions: duplicate guard, future dates, corrections", () => {
  it("refuses an identical entry on the same day unless explicitly allowed", async () => {
    setNow("2026-10-10");
    const { svc, cashflows } = build({});
    const dto = { type: "CONTRIBUTION", amount: 10000, occurredAt: "2026-10-05T00:00:00.000Z" } as never;
    await svc.addCashflow("u1", "i1", dto);
    await expect(svc.addCashflow("u1", "i1", dto)).rejects.toThrow(ConflictException);
    await svc.addCashflow("u1", "i1", { ...(dto as object), allowDuplicate: true } as never);
    expect(cashflows).toHaveLength(2);
  });

  it("a different amount or day is not a duplicate", async () => {
    setNow("2026-10-10");
    const { svc, cashflows } = build({});
    await svc.addCashflow("u1", "i1", { type: "CONTRIBUTION", amount: 10000, occurredAt: "2026-10-05T00:00:00.000Z" } as never);
    await svc.addCashflow("u1", "i1", { type: "CONTRIBUTION", amount: 10001, occurredAt: "2026-10-05T00:00:00.000Z" } as never);
    await svc.addCashflow("u1", "i1", { type: "CONTRIBUTION", amount: 10000, occurredAt: "2026-10-06T00:00:00.000Z" } as never);
    expect(cashflows).toHaveLength(3);
  });

  it("a future-dated transaction is rejected: it has not happened, so it is not invested", async () => {
    setNow("2026-10-10");
    const { svc, cashflows } = build({});
    await expect(svc.addCashflow("u1", "i1", { type: "CONTRIBUTION", amount: 500, occurredAt: "2026-12-01T00:00:00.000Z" } as never)).rejects.toThrow(/future/i);
    expect(cashflows).toHaveLength(0);
  });

  it("editing keeps a before/after audit trail; a generated row's date is locked but its amount can be fixed", async () => {
    setNow("2026-10-10");
    const { svc, cashflows, audit } = build({ ...activeSip, contributionStartDate: d("2026-10-05") });
    await svc.generateSipContributions("u1", "i1", new Date());
    const generated = cashflows[0];
    await expect(svc.updateCashflow("u1", "i1", generated.id, { occurredAt: "2026-10-06T00:00:00.000Z" } as never)).rejects.toThrow(/cannot be changed/i);
    const fixed = await svc.updateCashflow("u1", "i1", generated.id, { amount: 5500 } as never);
    expect(Number(fixed.amount)).toBe(5500);
    expect(audit).toHaveBeenCalledWith("investment.cashflow.update", "u1", expect.objectContaining({ before: expect.objectContaining({ amount: "5000" }), after: expect.objectContaining({ amount: "5500" }) }));
    await expect(svc.updateCashflow("u1", "i1", generated.id, {} as never)).rejects.toThrow(/nothing to change/i);
    await expect(svc.updateCashflow("u1", "i1", "nope", { amount: 1 } as never)).rejects.toThrow(NotFoundException);
  });

  it("the portfolio ledger is always scoped to the caller and pages server-side", async () => {
    const { svc, db } = build({});
    db.investmentCashflow.findMany.mockResolvedValueOnce([]);
    const out = await svc.listTransactions("u1", { page: 2, pageSize: 10, type: "CONTRIBUTION", q: "nifty", sort: "amount_desc" } as never);
    const args = db.investmentCashflow.findMany.mock.calls[0][0];
    expect(args.where.userId).toBe("u1");
    expect(args.where.type).toBe("CONTRIBUTION");
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
    expect(out.page).toBe(2);
    expect(out.totalPages).toBe(1);
  });
});
