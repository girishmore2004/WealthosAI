import { Test } from "@nestjs/testing";
import { ExpensesService } from "../src/expenses/expenses.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("ExpensesService", () => {
  let service: ExpensesService;
  const mockPrisma = { client: { expense: { findMany: jest.fn() }, category: { findMany: jest.fn() } } };

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
      expect(subs[0].merchant).toBe("netflix");
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
});
