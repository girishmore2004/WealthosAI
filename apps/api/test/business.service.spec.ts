import { Test } from "@nestjs/testing";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { BusinessService } from "../src/business/business.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";

describe("BusinessService.monthlySummary", () => {
  let service: BusinessService;
  const mockPrisma = {
    client: {
      business: { findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
      businessTransaction: { findMany: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), findUnique: jest.fn() },
      businessObligation: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "user-1", name: "Sunil Studio" });
    const moduleRef = await Test.createTestingModule({
      providers: [BusinessService, { provide: PrismaService, useValue: mockPrisma }, { provide: IncomeService, useValue: {} }],
    }).compile();
    service = moduleRef.get(BusinessService);
  });

  it("buckets revenue/expense/drawing transactions by month and computes profit correctly", async () => {
    mockPrisma.client.businessTransaction.findMany.mockResolvedValue([
      { type: "REVENUE", amount: 100000, occurredAt: new Date("2026-07-05") },
      { type: "EXPENSE", amount: 30000, occurredAt: new Date("2026-07-10") },
      { type: "OWNER_DRAWING", amount: 20000, occurredAt: new Date("2026-07-15") },
      { type: "REVENUE", amount: 80000, occurredAt: new Date("2026-06-05") },
      { type: "EXPENSE", amount: 25000, occurredAt: new Date("2026-06-10") },
    ]);

    const summary = await service.monthlySummary("user-1", "b1", "2026-07");

    expect(summary.revenue).toBe("100000.00");
    expect(summary.expenses).toBe("30000.00");
    expect(summary.ownerDrawings).toBe("20000.00");
    expect(summary.profit).toBe("70000.00");

    const juneEntry = summary.trend.find((t) => t.month === "2026-06");
    expect(juneEntry).toEqual({ month: "2026-06", revenue: 80000, expenses: 25000, profit: 55000 });
  });

  it("returns a zeroed month rather than throwing when a business has no transactions yet", async () => {
    mockPrisma.client.businessTransaction.findMany.mockResolvedValue([]);

    const summary = await service.monthlySummary("user-1", "b1", "2026-07");

    expect(summary.revenue).toBe("0.00");
    expect(summary.profit).toBe("0.00");
    expect(summary.trend).toHaveLength(6);
  });

  it("rejects access to a business the user does not own", async () => {
    mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "someone-else" });
    await expect(service.monthlySummary("user-1", "b1", "2026-07")).rejects.toThrow();
  });
});

describe("BusinessService update/remove flows (atomic ownership hardening)", () => {
  let service: BusinessService;
  const mockPrisma = {
    client: {
      business: { findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
      businessTransaction: { findMany: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), findUnique: jest.fn() },
      businessObligation: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [BusinessService, { provide: PrismaService, useValue: mockPrisma }, { provide: IncomeService, useValue: {} }],
    }).compile();
    service = moduleRef.get(BusinessService);
  });

  describe("updateBusiness", () => {
    it("updates and returns the row when it exists and is owned by the caller", async () => {
      mockPrisma.client.business.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", name: "Renamed Studio" });

      const result = await service.updateBusiness("user-1", "b1", { name: "Renamed Studio" });

      expect(mockPrisma.client.business.updateMany).toHaveBeenCalledWith({
        where: { id: "b1", userId: "user-1" },
        data: { name: "Renamed Studio", startedAt: undefined },
      });
      expect(result!.name).toBe("Renamed Studio");
    });

    it("converts a provided startedAt string into a real Date before writing", async () => {
      mockPrisma.client.business.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.business.findUnique.mockResolvedValue({});

      await service.updateBusiness("user-1", "b1", { startedAt: "2020-01-15" });

      const callArgs = mockPrisma.client.business.updateMany.mock.calls[0][0];
      expect(callArgs.data.startedAt).toBeInstanceOf(Date);
    });

    // Both "owned by someone else" and "doesn't exist" now produce the same atomic
    // updateMany count of 0, and therefore the same NotFoundException — a deliberate,
    // disclosed unification (matches the pattern applied across every other money
    // module this session) that avoids leaking which of the two cases actually occurred.
    it("throws NotFoundException without leaking whether the id belongs to another user or doesn't exist", async () => {
      mockPrisma.client.business.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.updateBusiness("user-1", "b1", { name: "Hijack" })).rejects.toThrow(NotFoundException);
      expect(mockPrisma.client.business.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("removeBusiness", () => {
    it("deletes atomically scoped by owner and returns the id", async () => {
      mockPrisma.client.business.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.removeBusiness("user-1", "b1");

      expect(mockPrisma.client.business.deleteMany).toHaveBeenCalledWith({ where: { id: "b1", userId: "user-1" } });
      expect(result).toEqual({ id: "b1" });
    });

    it("throws NotFoundException when the id doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.business.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeBusiness("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateTransaction", () => {
    it("updates a transaction scoped through the owning business's userId in a single atomic call", async () => {
      mockPrisma.client.businessTransaction.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue({ id: "t1", amount: 5000 });

      const result = await service.updateTransaction("user-1", "t1", { amount: 5000 } as any);

      expect(mockPrisma.client.businessTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: "t1", business: { userId: "user-1" } },
        data: { amount: 5000, occurredAt: undefined },
      });
      expect(result!.amount).toBe(5000);
    });

    it("throws NotFoundException for a transaction whose business belongs to someone else", async () => {
      mockPrisma.client.businessTransaction.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.updateTransaction("user-1", "t1", { amount: 1 } as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.client.businessTransaction.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("removeTransaction", () => {
    it("deletes atomically scoped through the owning business's userId", async () => {
      mockPrisma.client.businessTransaction.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.removeTransaction("user-1", "t1");

      expect(mockPrisma.client.businessTransaction.deleteMany).toHaveBeenCalledWith({
        where: { id: "t1", business: { userId: "user-1" } },
      });
      expect(result).toEqual({ id: "t1" });
    });

    it("throws NotFoundException when the transaction doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.businessTransaction.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeTransaction("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateObligation", () => {
    it("updates an obligation scoped through the owning business's userId in a single atomic call", async () => {
      mockPrisma.client.businessObligation.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.businessObligation.findUnique.mockResolvedValue({ id: "o1", status: "PAID" });

      const result = await service.updateObligation("user-1", "o1", { status: "PAID" as any });

      expect(mockPrisma.client.businessObligation.updateMany).toHaveBeenCalledWith({
        where: { id: "o1", business: { userId: "user-1" } },
        data: { status: "PAID", dueDate: undefined },
      });
      expect(result!.status).toBe("PAID");
    });

    it("throws NotFoundException for an obligation whose business belongs to someone else", async () => {
      mockPrisma.client.businessObligation.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.updateObligation("user-1", "o1", { status: "PAID" as any })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.client.businessObligation.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("removeObligation", () => {
    it("deletes atomically scoped through the owning business's userId", async () => {
      mockPrisma.client.businessObligation.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.removeObligation("user-1", "o1");

      expect(mockPrisma.client.businessObligation.deleteMany).toHaveBeenCalledWith({
        where: { id: "o1", business: { userId: "user-1" } },
      });
      expect(result).toEqual({ id: "o1" });
    });

    it("throws NotFoundException when the obligation doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.businessObligation.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeObligation("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });
});

describe("BusinessService.markObligationPaid (new — recurring obligation auto-regeneration)", () => {
  let service: BusinessService;
  const mockPrisma = {
    client: {
      business: { findUnique: jest.fn() },
      businessObligation: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "user-1" });
    const moduleRef = await Test.createTestingModule({
      providers: [BusinessService, { provide: PrismaService, useValue: mockPrisma }, { provide: IncomeService, useValue: {} }],
    }).compile();
    service = moduleRef.get(BusinessService);
  });

  it("marks the obligation paid and creates a MONTHLY next occurrence one month later", async () => {
    mockPrisma.client.businessObligation.findUnique.mockResolvedValue({
      id: "o1", businessId: "b1", title: "File GST Return", dueDate: new Date("2026-07-20"),
      amount: 5000, recurrence: "MONTHLY", vendor: "GST Portal", status: "PENDING", notes: null,
    });
    mockPrisma.client.businessObligation.update.mockResolvedValue({ id: "o1", status: "PAID" });
    mockPrisma.client.businessObligation.create.mockResolvedValue({ id: "o2", status: "PENDING" });

    const result = await service.markObligationPaid("user-1", "o1");

    expect(mockPrisma.client.businessObligation.update).toHaveBeenCalledWith({
      where: { id: "o1" },
      data: { status: "PAID" },
    });
    expect(mockPrisma.client.businessObligation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessId: "b1",
        title: "File GST Return",
        dueDate: new Date("2026-08-20"), // exactly one month later
        amount: 5000,
        recurrence: "MONTHLY",
        vendor: "GST Portal",
        status: "PENDING",
      }),
    });
    expect(result.paid.status).toBe("PAID");
    expect(result.nextOccurrence).not.toBeNull();
  });

  it("advances WEEKLY by 7 days, QUARTERLY by 3 months, and YEARLY by 1 year", async () => {
    const base = { id: "o1", businessId: "b1", title: "X", amount: null, vendor: null, status: "PENDING", notes: null };
    mockPrisma.client.businessObligation.update.mockResolvedValue({ status: "PAID" });

    mockPrisma.client.businessObligation.findUnique.mockResolvedValue({
      ...base, recurrence: "WEEKLY", dueDate: new Date("2026-07-01"),
    });
    await service.markObligationPaid("user-1", "o1");
    expect(mockPrisma.client.businessObligation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dueDate: new Date("2026-07-08") }) }),
    );

    jest.clearAllMocks();
    mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "user-1" });
    mockPrisma.client.businessObligation.update.mockResolvedValue({ status: "PAID" });
    mockPrisma.client.businessObligation.findUnique.mockResolvedValue({
      ...base, recurrence: "QUARTERLY", dueDate: new Date("2026-07-01"),
    });
    await service.markObligationPaid("user-1", "o1");
    expect(mockPrisma.client.businessObligation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dueDate: new Date("2026-10-01") }) }),
    );

    jest.clearAllMocks();
    mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "user-1" });
    mockPrisma.client.businessObligation.update.mockResolvedValue({ status: "PAID" });
    mockPrisma.client.businessObligation.findUnique.mockResolvedValue({
      ...base, recurrence: "YEARLY", dueDate: new Date("2026-07-01"),
    });
    await service.markObligationPaid("user-1", "o1");
    expect(mockPrisma.client.businessObligation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dueDate: new Date("2027-07-01") }) }),
    );
  });

  it("does NOT create a next occurrence for a ONE_TIME obligation", async () => {
    mockPrisma.client.businessObligation.findUnique.mockResolvedValue({
      id: "o1", businessId: "b1", title: "One-off filing", dueDate: new Date("2026-07-20"),
      recurrence: "ONE_TIME", status: "PENDING", amount: null, vendor: null, notes: null,
    });
    mockPrisma.client.businessObligation.update.mockResolvedValue({ status: "PAID" });

    const result = await service.markObligationPaid("user-1", "o1");

    expect(mockPrisma.client.businessObligation.create).not.toHaveBeenCalled();
    expect(result.nextOccurrence).toBeNull();
  });

  it("is idempotent: does NOT create a duplicate next occurrence if the obligation was already PAID", async () => {
    mockPrisma.client.businessObligation.findUnique.mockResolvedValue({
      id: "o1", businessId: "b1", title: "File GST Return", dueDate: new Date("2026-07-20"),
      recurrence: "MONTHLY", status: "PAID", amount: 5000, vendor: null, notes: null, // already PAID
    });
    mockPrisma.client.businessObligation.update.mockResolvedValue({ status: "PAID" });

    const result = await service.markObligationPaid("user-1", "o1");

    expect(mockPrisma.client.businessObligation.create).not.toHaveBeenCalled();
    expect(result.nextOccurrence).toBeNull();
  });

  it("rejects marking paid an obligation belonging to a business owned by someone else", async () => {
    mockPrisma.client.businessObligation.findUnique.mockResolvedValue({
      id: "o1", businessId: "b1", recurrence: "MONTHLY", status: "PENDING",
    });
    mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "someone-else" });

    await expect(service.markObligationPaid("user-1", "o1")).rejects.toThrow(NotFoundException);
    expect(mockPrisma.client.businessObligation.update).not.toHaveBeenCalled();
  });

  it("throws NotFoundException for an obligation that doesn't exist", async () => {
    mockPrisma.client.businessObligation.findUnique.mockResolvedValue(null);
    await expect(service.markObligationPaid("user-1", "missing")).rejects.toThrow(NotFoundException);
  });
});

describe("BusinessService.syncDrawingToIncome / unsyncDrawingFromIncome (new, audit item #9)", () => {
  let service: BusinessService;

  const mockPrisma = {
    client: {
      businessTransaction: { findUnique: jest.fn(), update: jest.fn() },
      income: { deleteMany: jest.fn() },
    },
  };
  const mockIncomeService = { create: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        BusinessService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncomeService },
      ],
    }).compile();
    service = moduleRef.get(BusinessService);
  });

  describe("syncDrawingToIncome", () => {
    it("creates a ONE_TIME BUSINESS-source Income row and links it back to the transaction", async () => {
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue({
        id: "t1",
        businessId: "b1",
        type: "OWNER_DRAWING",
        amount: 25000,
        occurredAt: new Date("2026-07-10"),
        description: "July drawing",
        syncedIncomeId: null,
        business: { id: "b1", userId: "user-1", name: "Sunil Studio" },
      });
      mockIncomeService.create.mockResolvedValue({ id: "income-1", amount: 25000 });
      mockPrisma.client.businessTransaction.update.mockResolvedValue({ id: "t1", syncedIncomeId: "income-1" });

      const result = await service.syncDrawingToIncome("user-1", "t1");

      expect(mockIncomeService.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ source: "BUSINESS", recurrence: "ONE_TIME", amount: 25000, label: expect.stringContaining("Sunil Studio") }),
      );
      expect(mockPrisma.client.businessTransaction.update).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { syncedIncomeId: "income-1" },
      });
      expect(result.income.id).toBe("income-1");
    });

    it("rejects syncing a REVENUE or EXPENSE transaction — only OWNER_DRAWING is eligible", async () => {
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue({
        id: "t1",
        type: "REVENUE",
        syncedIncomeId: null,
        business: { id: "b1", userId: "user-1", name: "Sunil Studio" },
      });

      await expect(service.syncDrawingToIncome("user-1", "t1")).rejects.toThrow(BadRequestException);
      expect(mockIncomeService.create).not.toHaveBeenCalled();
    });

    it("rejects syncing a transaction that's already synced (idempotency)", async () => {
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue({
        id: "t1",
        type: "OWNER_DRAWING",
        syncedIncomeId: "income-existing",
        business: { id: "b1", userId: "user-1", name: "Sunil Studio" },
      });

      await expect(service.syncDrawingToIncome("user-1", "t1")).rejects.toThrow(BadRequestException);
      expect(mockIncomeService.create).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for a transaction belonging to another user's business", async () => {
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue({
        id: "t1",
        type: "OWNER_DRAWING",
        syncedIncomeId: null,
        business: { id: "b1", userId: "someone-else", name: "Sunil Studio" },
      });

      await expect(service.syncDrawingToIncome("user-1", "t1")).rejects.toThrow(NotFoundException);
      expect(mockIncomeService.create).not.toHaveBeenCalled();
    });
  });

  describe("unsyncDrawingFromIncome", () => {
    it("deletes the linked Income row and clears syncedIncomeId", async () => {
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue({
        id: "t1",
        syncedIncomeId: "income-1",
        business: { id: "b1", userId: "user-1", name: "Sunil Studio" },
      });
      mockPrisma.client.income.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.businessTransaction.update.mockResolvedValue({ id: "t1", syncedIncomeId: null });

      await service.unsyncDrawingFromIncome("user-1", "t1");

      expect(mockPrisma.client.income.deleteMany).toHaveBeenCalledWith({ where: { id: "income-1", userId: "user-1" } });
      expect(mockPrisma.client.businessTransaction.update).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { syncedIncomeId: null },
      });
    });

    it("rejects unsyncing a transaction that was never synced", async () => {
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue({
        id: "t1",
        syncedIncomeId: null,
        business: { id: "b1", userId: "user-1", name: "Sunil Studio" },
      });

      await expect(service.unsyncDrawingFromIncome("user-1", "t1")).rejects.toThrow(BadRequestException);
      expect(mockPrisma.client.income.deleteMany).not.toHaveBeenCalled();
    });
  });
});
