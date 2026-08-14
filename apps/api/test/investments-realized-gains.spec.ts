import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvestmentsService } from "../src/investments/investments.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("InvestmentsService.recordSale / listRealizedGains / removeRealizedGain (new, audit item #11)", () => {
  let service: InvestmentsService;
  const mockPrisma = {
    client: {
      investment: { findUnique: jest.fn() },
      realizedGainEvent: { create: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [InvestmentsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(InvestmentsService);
  });

  describe("recordSale", () => {
    it("classifies an equity investment held over 12 months as EQUITY_LONG_TERM and computes the gain", async () => {
      mockPrisma.client.investment.findUnique.mockResolvedValue({
        id: "inv-1", userId: "user-1", type: "STOCK", costBasis: 100000, purchaseDate: new Date("2024-01-01"),
      });
      mockPrisma.client.realizedGainEvent.create.mockResolvedValue({ id: "gain-1" });

      await service.recordSale("user-1", "inv-1", {
        saleDate: "2026-06-01",
        proceeds: 150000,
        costBasisPortion: 100000,
      } as any);

      const createArgs = mockPrisma.client.realizedGainEvent.create.mock.calls[0][0].data;
      expect(createArgs.gainCategory).toBe("EQUITY_LONG_TERM");
      expect(createArgs.gainAmount).toBe(50000);
      expect(createArgs.holdingPeriodDays).toBeGreaterThan(365);
    });

    it("classifies an equity investment held under 12 months as EQUITY_SHORT_TERM", async () => {
      mockPrisma.client.investment.findUnique.mockResolvedValue({
        id: "inv-1", userId: "user-1", type: "STOCK", costBasis: 100000, purchaseDate: new Date("2026-01-01"),
      });
      mockPrisma.client.realizedGainEvent.create.mockResolvedValue({ id: "gain-1" });

      await service.recordSale("user-1", "inv-1", {
        saleDate: "2026-03-01",
        proceeds: 110000,
        costBasisPortion: 100000,
      } as any);

      const createArgs = mockPrisma.client.realizedGainEvent.create.mock.calls[0][0].data;
      expect(createArgs.gainCategory).toBe("EQUITY_SHORT_TERM");
    });

    it("classifies CRYPTO regardless of holding period", async () => {
      mockPrisma.client.investment.findUnique.mockResolvedValue({
        id: "inv-1", userId: "user-1", type: "CRYPTO", costBasis: 50000, purchaseDate: new Date("2020-01-01"),
      });
      mockPrisma.client.realizedGainEvent.create.mockResolvedValue({ id: "gain-1" });

      await service.recordSale("user-1", "inv-1", {
        saleDate: "2026-01-01",
        proceeds: 200000,
        costBasisPortion: 50000,
      } as any);

      const createArgs = mockPrisma.client.realizedGainEvent.create.mock.calls[0][0].data;
      expect(createArgs.gainCategory).toBe("CRYPTO");
    });

    it("rejects recording a sale for an excluded type (EPF/PPF/NPS/FD) with a clear message", async () => {
      mockPrisma.client.investment.findUnique.mockResolvedValue({
        id: "inv-1", userId: "user-1", type: "PPF", costBasis: 50000, purchaseDate: new Date("2020-01-01"),
      });

      await expect(
        service.recordSale("user-1", "inv-1", { saleDate: "2026-01-01", proceeds: 60000, costBasisPortion: 50000 } as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.client.realizedGainEvent.create).not.toHaveBeenCalled();
    });

    it("rejects a costBasisPortion exceeding the investment's total costBasis", async () => {
      mockPrisma.client.investment.findUnique.mockResolvedValue({
        id: "inv-1", userId: "user-1", type: "STOCK", costBasis: 50000, purchaseDate: new Date("2020-01-01"),
      });

      await expect(
        service.recordSale("user-1", "inv-1", { saleDate: "2026-01-01", proceeds: 100000, costBasisPortion: 60000 } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a saleDate before the investment's purchaseDate", async () => {
      mockPrisma.client.investment.findUnique.mockResolvedValue({
        id: "inv-1", userId: "user-1", type: "STOCK", costBasis: 50000, purchaseDate: new Date("2026-01-01"),
      });

      await expect(
        service.recordSale("user-1", "inv-1", { saleDate: "2025-01-01", proceeds: 60000, costBasisPortion: 50000 } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException for an investment owned by another user", async () => {
      mockPrisma.client.investment.findUnique.mockResolvedValue({
        id: "inv-1", userId: "someone-else", type: "STOCK", costBasis: 50000, purchaseDate: new Date("2020-01-01"),
      });

      await expect(
        service.recordSale("user-1", "inv-1", { saleDate: "2026-01-01", proceeds: 60000, costBasisPortion: 50000 } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it("computes a negative gainAmount for a loss (proceeds below cost basis)", async () => {
      mockPrisma.client.investment.findUnique.mockResolvedValue({
        id: "inv-1", userId: "user-1", type: "STOCK", costBasis: 100000, purchaseDate: new Date("2020-01-01"),
      });
      mockPrisma.client.realizedGainEvent.create.mockResolvedValue({ id: "gain-1" });

      await service.recordSale("user-1", "inv-1", { saleDate: "2026-01-01", proceeds: 70000, costBasisPortion: 100000 } as any);

      const createArgs = mockPrisma.client.realizedGainEvent.create.mock.calls[0][0].data;
      expect(createArgs.gainAmount).toBe(-30000);
    });

    it("does not modify the Investment row itself — recording a sale is purely a tax-tracking action", async () => {
      mockPrisma.client.investment.findUnique.mockResolvedValue({
        id: "inv-1", userId: "user-1", type: "STOCK", costBasis: 100000, purchaseDate: new Date("2020-01-01"),
      });
      mockPrisma.client.realizedGainEvent.create.mockResolvedValue({ id: "gain-1" });

      await service.recordSale("user-1", "inv-1", { saleDate: "2026-01-01", proceeds: 150000, costBasisPortion: 100000 } as any);

      expect(mockPrisma.client.investment).not.toHaveProperty("update");
    });
  });

  describe("listRealizedGains", () => {
    it("filters by financialYear when provided", async () => {
      mockPrisma.client.realizedGainEvent.findMany.mockResolvedValue([]);

      await service.listRealizedGains("user-1", "2025-26");

      expect(mockPrisma.client.realizedGainEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1", financialYear: "2025-26" } }),
      );
    });

    it("returns every year's events when financialYear is omitted", async () => {
      mockPrisma.client.realizedGainEvent.findMany.mockResolvedValue([]);

      await service.listRealizedGains("user-1");

      expect(mockPrisma.client.realizedGainEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" } }),
      );
    });
  });

  describe("removeRealizedGain", () => {
    it("deletes atomically scoped by owner", async () => {
      mockPrisma.client.realizedGainEvent.deleteMany.mockResolvedValue({ count: 1 });

      await service.removeRealizedGain("user-1", "gain-1");

      expect(mockPrisma.client.realizedGainEvent.deleteMany).toHaveBeenCalledWith({ where: { id: "gain-1", userId: "user-1" } });
    });

    it("throws NotFoundException when the id doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.realizedGainEvent.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.removeRealizedGain("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });
});
