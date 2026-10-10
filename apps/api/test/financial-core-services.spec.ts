jest.mock("../src/common/financial-facts/financial-facts.service", () => ({ FinancialFactsService: class {} }));

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { LegacyMigrationService } from "../src/financial-core/legacy-migration/legacy-migration.service";
import { EmergencyFundService } from "../src/financial-core/emergency-fund/emergency-fund.service";
import { InsurancePremiumService } from "../src/insurance/insurance-premium.service";
import { InvestmentLedgerService } from "../src/investments/investment-ledger.service";

const p2002 = () => Object.assign(new Error("unique"), { code: "P2002" });
const money = (v: string) => ({ toString: () => v });

describe("LegacyMigrationService", () => {
  const build = () => {
    const db = {
      expense: { findMany: jest.fn().mockResolvedValue([
        { id: "e1", amount: money("10000.00"), spentAt: new Date("2026-09-05T00:00:00Z"), merchant: "Axis Bluechip Fund", notes: null, category: { name: "SIP" } },
        { id: "e2", amount: money("7000.00"), spentAt: new Date("2026-09-06T00:00:00Z"), merchant: null, notes: null, category: { name: "Emergency Fund" } },
        { id: "e3", amount: money("500.00"), spentAt: new Date("2026-09-07T00:00:00Z"), merchant: "Unknown", notes: null, category: { name: "Savings" } },
      ]) },
      investment: { findMany: jest.fn().mockResolvedValue([{ id: "inv1", name: "Axis Bluechip Fund" }]) },
      investmentCashflow: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
      emergencyFundEntry: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return { db, audit, svc: new LegacyMigrationService({ client: db } as never, audit as never) };
  };

  it("dry run reports the plan and writes nothing, not even an audit row", async () => {
    const { db, audit, svc } = build();
    const r = await svc.run("u1", true);
    expect(r.summary).toMatchObject({ MIGRATED: 2, WARNING: 1 });
    expect(db.investmentCashflow.create).not.toHaveBeenCalled();
    expect(db.emergencyFundEntry.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("real run creates rows linked to the source expense and audits", async () => {
    const { db, audit, svc } = build();
    await svc.run("u1", false);
    expect(db.investmentCashflow.create.mock.calls[0][0].data).toMatchObject({ sourceExpenseId: "e1", investmentId: "inv1", type: "CONTRIBUTION", periodKey: "2026-09", origin: "LEGACY_EXPENSE_MIGRATION" });
    expect(db.emergencyFundEntry.create.mock.calls[0][0].data).toMatchObject({ sourceExpenseId: "e2", type: "ALLOCATE" });
    expect(audit.log).toHaveBeenCalledWith("FINANCIAL_LEGACY_MIGRATION", "u1", expect.objectContaining({ summary: expect.any(Object) }));
  });

  it("a unique-violation (concurrent run) becomes DUPLICATE, not a failure", async () => {
    const { db, svc } = build();
    db.investmentCashflow.create.mockRejectedValue(p2002());
    const r = await svc.run("u1", false);
    expect(r.items.find((i) => i.expenseId === "e1")?.status).toBe("DUPLICATE");
  });

  it("a real DB error is reported as ERROR, never swallowed", async () => {
    const { db, svc } = build();
    db.emergencyFundEntry.create.mockRejectedValue(new Error("db down"));
    const r = await svc.run("u1", false);
    expect(r.items.find((i) => i.expenseId === "e2")?.status).toBe("ERROR");
    expect(r.summary.ERROR).toBe(1);
  });
});

describe("EmergencyFundService", () => {
  const build = (balanceRows: Array<{ type: string; _sum: { amount: unknown } }>) => {
    const db = {
      emergencyFundEntry: {
        groupBy: jest.fn().mockResolvedValue(balanceRows),
        create: jest.fn().mockResolvedValue({ id: "n" }),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    };
    // Balance-dependent writes run in one transaction (with a per-user advisory lock);
    // the mock executes the callback against the same mocked client.
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
    return { db, svc: new EmergencyFundService({ client: db } as never, {} as never) };
  };
  const dto = (type: string, amount: number) => ({ type, amount, occurredAt: "2026-09-01T00:00:00Z" }) as never;

  it("allows an allocation and rejects non-positive amounts", async () => {
    const { svc } = build([]);
    await expect(svc.create("u1", dto("ALLOCATE", 7000))).resolves.toEqual({ id: "n" });
    await expect(svc.create("u1", dto("ALLOCATE", 0))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create("u1", dto("ADJUSTMENT", 0))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("cannot release more than the reserve holds", async () => {
    const { db, svc } = build([{ type: "ALLOCATE", _sum: { amount: 7000 } }]);
    await expect(svc.create("u1", dto("RELEASE", 7500))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create("u1", dto("RELEASE", 5000))).resolves.toBeDefined();
    expect(db.emergencyFundEntry.create).toHaveBeenCalledTimes(1);
  });

  it("delete is ownership-scoped (foreign or missing id is a 404 and deletes nothing)", async () => {
    const { db, svc } = build([]);
    db.emergencyFundEntry.findFirst.mockResolvedValue(null);
    await expect(svc.remove("u1", "x")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.emergencyFundEntry.findFirst).toHaveBeenCalledWith({ where: { id: "x", userId: "u1" } });
    expect(db.emergencyFundEntry.deleteMany).not.toHaveBeenCalled();
  });
});

describe("InsurancePremiumService idempotency (₹8,500 premium)", () => {
  const policy = { id: "p1", provider: "HDFC Ergo", type: "HEALTH", premiumAmount: money("8500.00"), premiumFrequency: "MONTHLY" };
  const build = () => {
    const db = {
      insurancePolicy: { findFirst: jest.fn().mockResolvedValue(policy) },
      expense: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: "x1" }) },
      category: { findUnique: jest.fn().mockResolvedValue({ id: "cat" }), create: jest.fn() },
    };
    return { db, svc: new InsurancePremiumService({ client: db } as never) };
  };

  it("creates a linked expense with source fields and the policy's amount", async () => {
    const { db, svc } = build();
    const r = await svc.recordPremium("u1", "p1", { paidAt: "2026-09-15T00:00:00Z" });
    expect(r).toEqual({ created: true, expenseId: "x1", period: "2026-09" });
    expect(db.expense.create.mock.calls[0][0].data).toMatchObject({ sourceType: "INSURANCE_PREMIUM", sourceId: "p1", sourceReference: "2026-09", amount: policy.premiumAmount });
  });

  it("recording the same policy+period again does not create a second expense", async () => {
    const { db, svc } = build();
    db.expense.findFirst.mockResolvedValue({ id: "existing" });
    const r = await svc.recordPremium("u1", "p1", { paidAt: "2026-09-20T00:00:00Z" });
    expect(r).toEqual({ created: false, expenseId: "existing", period: "2026-09" });
    expect(db.expense.create).not.toHaveBeenCalled();
  });

  it("a concurrent insert that hits the unique index resolves to the winner", async () => {
    const { db, svc } = build();
    db.expense.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "winner" });
    db.expense.create.mockRejectedValue(p2002());
    expect(await svc.recordPremium("u1", "p1", { paidAt: "2026-09-15T00:00:00Z" })).toMatchObject({ created: false, expenseId: "winner" });
  });

  it("rejects another user's policy and invalid periods", async () => {
    const { db, svc } = build();
    db.insurancePolicy.findFirst.mockResolvedValue(null);
    await expect(svc.recordPremium("u2", "p1")).rejects.toBeInstanceOf(NotFoundException);
    db.insurancePolicy.findFirst.mockResolvedValue(policy);
    await expect(svc.recordPremium("u1", "p1", { period: "2026-Q3" })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.insurancePolicy.findFirst.mock.calls[0][0].where).toEqual({ id: "p1", userId: "u2" });
  });
});

describe("InvestmentLedgerService SIP generation", () => {
  const inv = (o: object = {}) => ({
    id: "i1", type: "MUTUAL_FUND", sipActive: true, monthlyContribution: money("10000.00"), contributionDay: 5,
    contributionStartDate: new Date("2026-09-01T00:00:00Z"), contributionEndDate: null, ...o,
  });
  const build = (investment: object | null, keyed: Array<{ periodKey: string }> = []) => {
    const db = {
      investment: { findFirst: jest.fn().mockResolvedValue(investment), update: jest.fn(), findMany: jest.fn() },
      investmentCashflow: { findMany: jest.fn().mockResolvedValueOnce(keyed).mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
    };
    return { db, svc: new InvestmentLedgerService({ client: db } as never, {} as never) };
  };
  const asOf = new Date("2026-11-10T00:00:00Z");

  it("generates Sept/Oct/Nov once as CONTRIBUTION cashflows (never expenses)", async () => {
    const { db, svc } = build(inv());
    const r = await svc.generateSipContributions("u1", "i1", asOf);
    expect(r.created).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(db.investmentCashflow.create.mock.calls.every((c) => c[0].data.type === "CONTRIBUTION" && c[0].data.origin === "RECURRING")).toBe(true);
  });

  it("running again creates nothing", async () => {
    const { db, svc } = build(inv(), [{ periodKey: "2026-09" }, { periodKey: "2026-10" }, { periodKey: "2026-11" }]);
    const r = await svc.generateSipContributions("u1", "i1", asOf);
    expect(r.created).toEqual([]);
    expect(r.alreadyExisted).toHaveLength(3);
    expect(db.investmentCashflow.create).not.toHaveBeenCalled();
  });

  it("does nothing for an inactive schedule, and 404s on someone else's investment", async () => {
    const { db, svc } = build(inv({ sipActive: false }));
    expect((await svc.generateSipContributions("u1", "i1", asOf)).created).toEqual([]);
    expect(db.investmentCashflow.create).not.toHaveBeenCalled();
    const other = build(null);
    await expect(other.svc.generateSipContributions("u2", "i1", asOf)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("requires explicit confirmation before backfilling past months as actuals", async () => {
    const { svc } = build(inv());
    const dto = { monthlyContribution: 10000, contributionDay: 5, startDate: "2020-01-01", active: true } as never;
    await expect(svc.setSipSchedule("u1", "i1", dto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a schedule on a stock", async () => {
    const { svc } = build(inv({ type: "STOCK" }));
    const dto = { monthlyContribution: 1, contributionDay: 5, startDate: new Date().toISOString(), active: true } as never;
    await expect(svc.setSipSchedule("u1", "i1", dto)).rejects.toBeInstanceOf(BadRequestException);
  });
});
