import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TransfersService } from "../src/transfers/transfers.service";

describe("TransfersService (internal transfers are not income, expense or investment)", () => {
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const db = {
    accountTransfer: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
    },
  };
  const svc = new TransfersService({ client: db } as never, audit as never);
  const row = (over = {}) => ({
    id: "t1", userId: "u1", fromAccount: "HDFC Savings", toAccount: "Paytm Wallet", amount: 3000, currency: "INR",
    transferredAt: new Date("2026-10-02T00:00:00Z"), notes: null, createdAt: new Date("2026-10-02T01:00:00Z"), ...over,
  });

  beforeEach(() => jest.clearAllMocks());

  it("records a ₹3,000 transfer between two different accounts", async () => {
    db.accountTransfer.create.mockResolvedValue(row());
    const out = await svc.create("u1", { fromAccount: "HDFC Savings", toAccount: "Paytm Wallet", amount: 3000, transferredAt: "2026-10-02" } as never);
    expect(out).toMatchObject({ id: "t1", amount: "3000.00", fromAccount: "HDFC Savings", toAccount: "Paytm Wallet" });
    expect(db.accountTransfer.create.mock.calls[0][0].data.userId).toBe("u1");
  });

  it("rejects the same account on both sides (case-insensitive) and future dates", async () => {
    await expect(svc.create("u1", { fromAccount: "HDFC", toAccount: " hdfc ", amount: 10, transferredAt: "2026-10-02" } as never)).rejects.toBeInstanceOf(BadRequestException);
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    await expect(svc.create("u1", { fromAccount: "A", toAccount: "B", amount: 10, transferredAt: future } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.accountTransfer.create).not.toHaveBeenCalled();
  });

  it("delete is ownership-scoped (foreign or missing id is a 404)", async () => {
    db.accountTransfer.deleteMany.mockResolvedValue({ count: 0 });
    await expect(svc.remove("u1", "x")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.accountTransfer.deleteMany).toHaveBeenCalledWith({ where: { id: "x", userId: "u1" } });
  });

  it("lists only the caller's transfers, optionally date-bounded", async () => {
    await svc.list("u1", { from: "2026-10-01", to: "2026-10-31" });
    const where = db.accountTransfer.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    expect(where.transferredAt.gte).toBeInstanceOf(Date);
    expect(where.transferredAt.lte).toBeInstanceOf(Date);
  });
});
