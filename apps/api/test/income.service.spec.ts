import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { IncomeService } from "../src/income/income.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("IncomeService", () => {
  let service: IncomeService;
  const mockPrisma = {
    client: {
      income: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        findUnique: jest.fn(),
      },
      // NEW (audit item #4) — used by update()'s salary-history logging.
      incomeHistory: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [IncomeService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(IncomeService);
  });

  describe("monthlyForecast", () => {
    it("counts a MONTHLY income at full value", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 90000, recurrence: "MONTHLY" }]);
      expect(await service.monthlyForecast("user-1")).toBe(90000);
    });

    it("excludes ONE_TIME income entirely from the recurring monthly forecast", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([
        { amount: 90000, recurrence: "MONTHLY" },
        { amount: 500000, recurrence: "ONE_TIME" },
      ]);
      expect(await service.monthlyForecast("user-1")).toBe(90000);
    });

    it("prorates YEARLY income down to a monthly figure", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 1200000, recurrence: "YEARLY" }]);
      expect(await service.monthlyForecast("user-1")).toBeCloseTo(100000, 0);
    });

    it("prorates WEEKLY income up to a monthly figure (~4.33 weeks/month)", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 5000, recurrence: "WEEKLY" }]);
      expect(await service.monthlyForecast("user-1")).toBeCloseTo(21650, -1);
    });

    it("sums multiple recurring incomes of different frequencies correctly", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([
        { amount: 90000, recurrence: "MONTHLY" },
        { amount: 12000, recurrence: "QUARTERLY" }, // 4000/mo
      ]);
      expect(await service.monthlyForecast("user-1")).toBeCloseTo(94000, 0);
    });

    it("returns 0 rather than NaN when there's no income logged", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([]);
      expect(await service.monthlyForecast("user-1")).toBe(0);
    });

    it("treats a row with no currency set as INR (defensive default, matches the schema default)", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 90000, recurrence: "MONTHLY" }]);
      expect(await service.monthlyForecast("user-1")).toBe(90000);
    });

    it("excludes non-INR income from the monthly total instead of summing it as if it were rupees", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([
        { amount: 90000, recurrence: "MONTHLY", currency: "INR" },
        { amount: 500, recurrence: "MONTHLY", currency: "USD" },
      ]);
      expect(await service.monthlyForecast("user-1")).toBe(90000);
    });
  });

  describe("monthlyForecastBreakdown", () => {
    it("matches monthlyForecast()'s total and surfaces excluded one-time income", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([
        { amount: 90000, recurrence: "MONTHLY", currency: "INR" },
        { amount: 500000, recurrence: "ONE_TIME", currency: "INR" },
      ]);

      const breakdown = await service.monthlyForecastBreakdown("user-1");

      expect(breakdown.totalMonthlyIncome).toBe(90000);
      expect(breakdown.byRecurrence.MONTHLY).toBe(90000);
      expect(breakdown.oneTimeIncomeExcluded).toEqual({ count: 1, total: 500000 });
      expect(breakdown.excludedNonBaseCurrency).toEqual({ count: 0, currencies: [] });
    });

    it("reports excluded non-base-currency rows by currency code", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([
        { amount: 90000, recurrence: "MONTHLY", currency: "INR" },
        { amount: 500, recurrence: "MONTHLY", currency: "USD" },
        { amount: 300, recurrence: "MONTHLY", currency: "USD" },
      ]);

      const breakdown = await service.monthlyForecastBreakdown("user-1");

      expect(breakdown.totalMonthlyIncome).toBe(90000);
      expect(breakdown.excludedNonBaseCurrency).toEqual({ count: 2, currencies: ["USD"] });
    });
  });

  describe("list (single-flight coalescing)", () => {
    it("issues only one query for concurrent calls with the same userId", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 1, recurrence: "MONTHLY" }]);

      const [a, b] = await Promise.all([service.list("user-1"), service.list("user-1")]);

      expect(a).toBe(b); // same resolved array reference — proves it was the same promise
      expect(mockPrisma.client.income.findMany).toHaveBeenCalledTimes(1);
    });

    it("does not coalesce concurrent calls for different userIds", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([]);

      await Promise.all([service.list("user-1"), service.list("user-2")]);

      expect(mockPrisma.client.income.findMany).toHaveBeenCalledTimes(2);
    });

    it("issues a fresh query for a later, non-concurrent call (no stale caching)", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([]);

      await service.list("user-1");
      await service.list("user-1");

      expect(mockPrisma.client.income.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("listPaged", () => {
    it("applies default page/pageSize and returns a paging envelope", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 1, recurrence: "MONTHLY" }]);
      mockPrisma.client.income.count.mockResolvedValue(1);

      const result = await service.listPaged("user-1", {});

      expect(mockPrisma.client.income.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" }, skip: 0, take: 25 }),
      );
      expect(result).toEqual({ items: expect.any(Array), total: 1, page: 1, pageSize: 25, totalPages: 1 });
    });

    it("applies a receivedAt date-range filter when from/to are provided", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([]);
      mockPrisma.client.income.count.mockResolvedValue(0);

      await service.listPaged("user-1", { from: "2026-01-01", to: "2026-01-31" });

      expect(mockPrisma.client.income.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: "user-1",
            receivedAt: { gte: new Date("2026-01-01"), lte: new Date("2026-01-31") },
          },
        }),
      );
    });
  });

  describe("update", () => {
    // NEW behavioral note (audit item #4): update() now reads the row FIRST (to
    // compare its prior amount against any incoming amount change, for
    // IncomeHistory logging) before performing the atomic, ownership-scoped
    // updateMany(). The actual mutation is still scoped by { id, userId } exactly as
    // before — this read adds an earlier, equally-strict ownership check (thrown
    // before any write is attempted), it does not weaken the existing one.
    it("updates and returns the row when it exists and is owned by the caller", async () => {
      mockPrisma.client.income.findUnique
        .mockResolvedValueOnce({ id: "income-1", userId: "user-1", amount: 50000 }) // pre-update read
        .mockResolvedValueOnce({ id: "income-1", label: "Updated" }); // post-update read
      mockPrisma.client.income.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.update("user-1", "income-1", { label: "Updated" });

      expect(mockPrisma.client.income.updateMany).toHaveBeenCalledWith({
        where: { id: "income-1", userId: "user-1" },
        data: { label: "Updated", receivedAt: undefined },
      });
      expect(result).toEqual({ id: "income-1", label: "Updated" });
      // Editing only the label — no amount change, so no history entry.
      expect(mockPrisma.client.incomeHistory.create).not.toHaveBeenCalled();
    });

    it("throws NotFoundException without leaking whether the id exists for another user", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValueOnce(null); // pre-update read finds nothing

      await expect(service.update("user-1", "not-mine", { label: "x" })).rejects.toThrow(NotFoundException);
      // The ownership check now happens on this initial read rather than via
      // updateMany's count — so updateMany is never even attempted for a
      // nonexistent/not-owned row.
      expect(mockPrisma.client.income.updateMany).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when the row exists but belongs to another user", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValueOnce({ id: "income-1", userId: "someone-else", amount: 50000 });

      await expect(service.update("user-1", "income-1", { label: "x" })).rejects.toThrow(NotFoundException);
      expect(mockPrisma.client.income.updateMany).not.toHaveBeenCalled();
    });

    describe("salary/amount-change history logging (new, audit item #4)", () => {
      it("logs an IncomeHistory entry when amount changes, with previous/new amounts", async () => {
        mockPrisma.client.income.findUnique
          .mockResolvedValueOnce({ id: "income-1", userId: "user-1", amount: 50000 })
          .mockResolvedValueOnce({ id: "income-1", amount: 60000 });
        mockPrisma.client.income.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.client.incomeHistory.create.mockResolvedValue({ id: "hist-1" });

        await service.update("user-1", "income-1", { amount: 60000 });

        expect(mockPrisma.client.incomeHistory.create).toHaveBeenCalledWith({
          data: {
            userId: "user-1",
            incomeId: "income-1",
            previousAmount: 50000,
            newAmount: 60000,
            effectiveFrom: expect.any(Date),
          },
        });
      });

      it("does not log a history entry when amount is included but unchanged", async () => {
        mockPrisma.client.income.findUnique
          .mockResolvedValueOnce({ id: "income-1", userId: "user-1", amount: 50000 })
          .mockResolvedValueOnce({ id: "income-1", amount: 50000 });
        mockPrisma.client.income.updateMany.mockResolvedValue({ count: 1 });

        await service.update("user-1", "income-1", { amount: 50000, label: "Same amount, new label" });

        expect(mockPrisma.client.incomeHistory.create).not.toHaveBeenCalled();
      });

      it("uses the explicit effectiveFrom date when provided instead of 'now'", async () => {
        mockPrisma.client.income.findUnique
          .mockResolvedValueOnce({ id: "income-1", userId: "user-1", amount: 50000 })
          .mockResolvedValueOnce({ id: "income-1", amount: 60000 });
        mockPrisma.client.income.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.client.incomeHistory.create.mockResolvedValue({ id: "hist-1" });

        await service.update("user-1", "income-1", { amount: 60000, effectiveFrom: "2026-07-01" });

        expect(mockPrisma.client.incomeHistory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ effectiveFrom: new Date("2026-07-01") }),
        });
      });

      it("never sends effectiveFrom through to the Income row's own updateMany call", async () => {
        mockPrisma.client.income.findUnique
          .mockResolvedValueOnce({ id: "income-1", userId: "user-1", amount: 50000 })
          .mockResolvedValueOnce({ id: "income-1", amount: 60000 });
        mockPrisma.client.income.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.client.incomeHistory.create.mockResolvedValue({ id: "hist-1" });

        await service.update("user-1", "income-1", { amount: 60000, effectiveFrom: "2026-07-01" });

        const updateManyArgs = mockPrisma.client.income.updateMany.mock.calls[0][0];
        expect(updateManyArgs.data).not.toHaveProperty("effectiveFrom");
      });
    });
  });

  describe("history (new, audit item #4)", () => {
    it("returns the row's history, most-recent-first", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValue({ id: "income-1", userId: "user-1" });
      mockPrisma.client.incomeHistory.findMany.mockResolvedValue([{ id: "hist-2" }, { id: "hist-1" }]);

      const result = await service.history("user-1", "income-1");

      expect(mockPrisma.client.incomeHistory.findMany).toHaveBeenCalledWith({
        where: { incomeId: "income-1" },
        orderBy: { effectiveFrom: "desc" },
      });
      expect(result).toEqual([{ id: "hist-2" }, { id: "hist-1" }]);
    });

    it("throws NotFoundException for an income row belonging to another user", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValue({ id: "income-1", userId: "someone-else" });
      await expect(service.history("user-1", "income-1")).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException for a nonexistent income row", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValue(null);
      await expect(service.history("user-1", "missing")).rejects.toThrow(NotFoundException);
    });
  });

  describe("remove", () => {
    it("deletes atomically scoped by owner and returns the id", async () => {
      mockPrisma.client.income.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.remove("user-1", "income-1");

      expect(mockPrisma.client.income.deleteMany).toHaveBeenCalledWith({
        where: { id: "income-1", userId: "user-1" },
      });
      expect(result).toEqual({ id: "income-1" });
    });

    it("throws NotFoundException when the id doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.income.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.remove("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });
});
