import { Test } from "@nestjs/testing";
import { BusinessService } from "../src/business/business.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("BusinessService.monthlySummary", () => {
  let service: BusinessService;
  const mockPrisma = {
    client: {
      business: { findUnique: jest.fn(), findMany: jest.fn() },
      businessTransaction: { findMany: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "user-1", name: "Sunil Studio" });
    const moduleRef = await Test.createTestingModule({
      providers: [BusinessService, { provide: PrismaService, useValue: mockPrisma }],
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

describe("BusinessService update flows", () => {
  let service: BusinessService;
  const mockPrisma = {
    client: {
      business: { findUnique: jest.fn(), update: jest.fn() },
      businessTransaction: { findUnique: jest.fn(), update: jest.fn() },
      businessObligation: { findUnique: jest.fn(), update: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [BusinessService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(BusinessService);
  });

  describe("updateBusiness", () => {
    it("updates a business the user owns", async () => {
      mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "user-1" });
      mockPrisma.client.business.update.mockResolvedValue({ id: "b1", userId: "user-1", name: "Renamed Studio" });

      const result = await service.updateBusiness("user-1", "b1", { name: "Renamed Studio" });

      expect(mockPrisma.client.business.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "b1" } }),
      );
      expect(result.name).toBe("Renamed Studio");
    });

    it("converts a provided startedAt string into a real Date before writing", async () => {
      mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "user-1" });
      mockPrisma.client.business.update.mockResolvedValue({});

      await service.updateBusiness("user-1", "b1", { startedAt: "2020-01-15" });

      const callArgs = mockPrisma.client.business.update.mock.calls[0][0];
      expect(callArgs.data.startedAt).toBeInstanceOf(Date);
    });

    it("rejects updating a business owned by someone else", async () => {
      mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "someone-else" });

      await expect(service.updateBusiness("user-1", "b1", { name: "Hijack" })).rejects.toThrow();
      expect(mockPrisma.client.business.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for a business that doesn't exist", async () => {
      mockPrisma.client.business.findUnique.mockResolvedValue(null);

      await expect(service.updateBusiness("user-1", "missing", { name: "X" })).rejects.toThrow();
    });
  });

  describe("updateTransaction", () => {
    it("updates a transaction belonging to a business the user owns", async () => {
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue({ id: "t1", businessId: "b1" });
      mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "user-1" });
      mockPrisma.client.businessTransaction.update.mockResolvedValue({ id: "t1", amount: 5000 });

      const result = await service.updateTransaction("user-1", "t1", { amount: 5000 });

      expect(result.amount).toBe(5000);
      expect(mockPrisma.client.businessTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "t1" } }),
      );
    });

    it("rejects updating a transaction whose business belongs to someone else", async () => {
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue({ id: "t1", businessId: "b1" });
      mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "someone-else" });

      await expect(service.updateTransaction("user-1", "t1", { amount: 1 })).rejects.toThrow();
      expect(mockPrisma.client.businessTransaction.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for a transaction that doesn't exist", async () => {
      mockPrisma.client.businessTransaction.findUnique.mockResolvedValue(null);

      await expect(service.updateTransaction("user-1", "missing", { amount: 1 })).rejects.toThrow();
    });
  });

  describe("updateObligation", () => {
    it("updates an obligation belonging to a business the user owns", async () => {
      mockPrisma.client.businessObligation.findUnique.mockResolvedValue({ id: "o1", businessId: "b1" });
      mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "user-1" });
      mockPrisma.client.businessObligation.update.mockResolvedValue({ id: "o1", status: "PAID" });

      const result = await service.updateObligation("user-1", "o1", { status: "PAID" as any });

      expect(result.status).toBe("PAID");
    });

    it("rejects updating an obligation whose business belongs to someone else", async () => {
      mockPrisma.client.businessObligation.findUnique.mockResolvedValue({ id: "o1", businessId: "b1" });
      mockPrisma.client.business.findUnique.mockResolvedValue({ id: "b1", userId: "someone-else" });

      await expect(service.updateObligation("user-1", "o1", { status: "PAID" as any })).rejects.toThrow();
      expect(mockPrisma.client.businessObligation.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for an obligation that doesn't exist", async () => {
      mockPrisma.client.businessObligation.findUnique.mockResolvedValue(null);

      await expect(service.updateObligation("user-1", "missing", { status: "PAID" as any })).rejects.toThrow();
    });
  });
});
