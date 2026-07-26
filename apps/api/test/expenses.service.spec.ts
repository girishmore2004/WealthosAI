import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { ExpensesService } from "../src/expenses/expenses.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("ExpensesService", () => {
  let service: ExpensesService;
  const mockPrisma = {
    client: {
      expense: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        findUnique: jest.fn(),
      },
      category: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [ExpensesService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(ExpensesService);
  });

  describe("detectSubscriptions", () => {
    it("flags a merchant seen 2+ times as a likely subscription, at MEDIUM confidence", async () => {
      mockPrisma.client.expense.findMany.mockResolvedValue([
        { id: "e1", merchant: "Netflix", amount: 649, spentAt: new Date("2026-07-05") },
        { id: "e2", merchant: "Netflix", amount: 649, spentAt: new Date("2026-06-05") },
        { id: "e3", merchant: "One-off Store", amount: 2000, spentAt: new Date("2026-07-01") },
      ]);

      const subs = await service.detectSubscriptions("user-1");

      expect(subs).toHaveLength(1);
      // Was "netflix" (raw-lowercased) before the merchant-normalization fix; now
      // returns the normalized, display-friendly form. See the class-level comment on
      // detectSubscriptions() for why this is a disclosed, intentional change.
      expect(subs[0].merchant).toBe("Netflix");
      expect(subs[0].occurrences).toBe(2);
      expect(subs[0].averageAmount).toBe(649);
      expect(subs[0].confidence).toBe("MEDIUM");
      expect(subs[0].sourceExpenseIds.sort()).toEqual(["e1", "e2"]);
    });

    it("flags a merchant seen 3+ times at HIGH confidence", async () => {
      mockPrisma.client.expense.findMany.mockResolvedValue([
        { id: "e1", merchant: "Netflix", amount: 649, spentAt: new Date("2026-07-05") },
        { id: "e2", merchant: "Netflix", amount: 649, spentAt: new Date("2026-06-05") },
        { id: "e3", merchant: "Netflix", amount: 649, spentAt: new Date("2026-05-05") },
      ]);

      const subs = await service.detectSubscriptions("user-1");

      expect(subs[0].confidence).toBe("HIGH");
    });

    it("reports the most recent occurrence as lastSeenAt", async () => {
      mockPrisma.client.expense.findMany.mockResolvedValue([
        { id: "e1", merchant: "Netflix", amount: 649, spentAt: new Date("2026-07-05") },
        { id: "e2", merchant: "Netflix", amount: 649, spentAt: new Date("2026-06-05") },
      ]);

      const subs = await service.detectSubscriptions("user-1");

      expect(subs[0].lastSeenAt).toBe(new Date("2026-07-05").toISOString());
    });

    it("is case-insensitive when grouping merchant names", async () => {
      mockPrisma.client.expense.findMany.mockResolvedValue([
        { id: "e1", merchant: "Spotify", amount: 119, spentAt: new Date("2026-07-01") },
        { id: "e2", merchant: "SPOTIFY", amount: 119, spentAt: new Date("2026-06-01") },
      ]);

      const subs = await service.detectSubscriptions("user-1");

      expect(subs).toHaveLength(1);
      expect(subs[0].occurrences).toBe(2);
    });

    it("does not flag a merchant seen only once", async () => {
      mockPrisma.client.expense.findMany.mockResolvedValue([
        { id: "e1", merchant: "Rare Purchase", amount: 500, spentAt: new Date("2026-07-01") },
      ]);

      const subs = await service.detectSubscriptions("user-1");

      expect(subs).toHaveLength(0);
    });

    it("groups the same merchant across different trailing statement reference numbers (the normalization fix)", async () => {
      // Two real bank-statement lines for the same subscription, differing only in the
      // trailing reference number a bank appends per-transaction — exactly the case the
      // old raw-lowercase grouping missed, and the case Copilot Ingestion's
      // normalizeMerchantText() already handles for statement imports.
      mockPrisma.client.expense.findMany.mockResolvedValue([
        { id: "e1", merchant: "POS Netflix 4829102", amount: 649, spentAt: new Date("2026-07-05") },
        { id: "e2", merchant: "POS Netflix 5810293", amount: 649, spentAt: new Date("2026-06-05") },
      ]);

      const subs = await service.detectSubscriptions("user-1");

      expect(subs).toHaveLength(1);
      expect(subs[0].merchant).toBe("Netflix");
      expect(subs[0].occurrences).toBe(2);
    });
  });

  describe("categoryBreakdown", () => {
    it("sums amounts per category and sorts descending by total", async () => {
      mockPrisma.client.expense.findMany.mockResolvedValue([
        { categoryId: "c1", amount: 5000, category: { name: "Rent", type: "NEED" } },
        { categoryId: "c2", amount: 2000, category: { name: "Dining", type: "WANT" } },
        { categoryId: "c2", amount: 6000, category: { name: "Dining", type: "WANT" } },
      ]);

      const breakdown = await service.categoryBreakdown("user-1");

      expect(breakdown[0].name).toBe("Dining"); // 8000 total, unambiguously higher than Rent's 5000
      expect(breakdown[0].total).toBe(8000);
      expect(breakdown[1].name).toBe("Rent");
      expect(breakdown[1].total).toBe(5000);
    });

    it("returns an empty array rather than throwing when there are no expenses", async () => {
      mockPrisma.client.expense.findMany.mockResolvedValue([]);
      const breakdown = await service.categoryBreakdown("user-1");
      expect(breakdown).toEqual([]);
    });
  });

  describe("createCategory", () => {
    it("creates a new category when no matching name exists", async () => {
      mockPrisma.client.category.findFirst.mockResolvedValue(null);
      mockPrisma.client.category.create.mockResolvedValue({ id: "c1", name: "Hobbies", type: "WANT" });

      const result = await service.createCategory({ name: "Hobbies", type: "WANT" } as any);

      expect(mockPrisma.client.category.create).toHaveBeenCalled();
      expect(result).toEqual({ id: "c1", name: "Hobbies", type: "WANT" });
    });

    it("returns the existing category instead of throwing on a case-insensitive name match", async () => {
      mockPrisma.client.category.findFirst.mockResolvedValue({ id: "existing", name: "Food", type: "NEED" });

      const result = await service.createCategory({ name: "food", type: "NEED" } as any);

      expect(mockPrisma.client.category.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "existing", name: "Food", type: "NEED" });
    });

    it("recovers gracefully from a race (P2002) instead of surfacing a raw 500", async () => {
      mockPrisma.client.category.findFirst
        .mockResolvedValueOnce(null) // pre-check sees nothing yet
        .mockResolvedValueOnce({ id: "winner", name: "Groceries", type: "NEED" }); // recovery lookup after the race
      mockPrisma.client.category.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "5.0.0",
        }),
      );

      const result = await service.createCategory({ name: "Groceries", type: "NEED" } as any);

      expect(result).toEqual({ id: "winner", name: "Groceries", type: "NEED" });
    });
  });

  describe("listPaged", () => {
    it("applies default page/pageSize and returns a paging envelope", async () => {
      mockPrisma.client.expense.findMany.mockResolvedValue([{ id: "e1" }]);
      mockPrisma.client.expense.count.mockResolvedValue(1);

      const result = await service.listPaged("user-1", {});

      expect(mockPrisma.client.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" }, skip: 0, take: 25 }),
      );
      expect(result).toEqual({ items: expect.any(Array), total: 1, page: 1, pageSize: 25, totalPages: 1 });
    });

    it("applies category and date-range filters when provided", async () => {
      mockPrisma.client.expense.findMany.mockResolvedValue([]);
      mockPrisma.client.expense.count.mockResolvedValue(0);

      await service.listPaged("user-1", { categoryId: "c1", from: "2026-01-01", to: "2026-01-31" });

      expect(mockPrisma.client.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: "user-1",
            categoryId: "c1",
            spentAt: { gte: new Date("2026-01-01"), lte: new Date("2026-01-31") },
          },
        }),
      );
    });
  });

  describe("update", () => {
    it("updates and returns the row when it exists and is owned by the caller", async () => {
      mockPrisma.client.expense.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.expense.findUnique.mockResolvedValue({ id: "e1", merchant: "Updated" });

      const result = await service.update("user-1", "e1", { merchant: "Updated" } as any);

      expect(mockPrisma.client.expense.updateMany).toHaveBeenCalledWith({
        where: { id: "e1", userId: "user-1" },
        data: { merchant: "Updated", spentAt: undefined },
      });
      expect(result).toEqual({ id: "e1", merchant: "Updated" });
    });

    it("throws NotFoundException without leaking whether the id exists for another user", async () => {
      mockPrisma.client.expense.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.update("user-1", "not-mine", {} as any)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.client.expense.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes atomically scoped by owner and returns the id", async () => {
      mockPrisma.client.expense.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.remove("user-1", "e1");

      expect(mockPrisma.client.expense.deleteMany).toHaveBeenCalledWith({
        where: { id: "e1", userId: "user-1" },
      });
      expect(result).toEqual({ id: "e1" });
    });

    it("throws NotFoundException when the id doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.expense.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.remove("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });
});
