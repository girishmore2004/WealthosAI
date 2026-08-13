import { Test } from "@nestjs/testing";
import { FinancialFactsService } from "../src/common/financial-facts/financial-facts.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";
import { ExpensesService } from "../src/expenses/expenses.service";

describe("FinancialFactsService", () => {
  let service: FinancialFactsService;

  const mockPrisma = { client: { goal: { findMany: jest.fn() } } };
  const mockIncomeService = { monthlyForecast: jest.fn(), list: jest.fn() };
  const mockExpensesService = { list: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        FinancialFactsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncomeService },
        { provide: ExpensesService, useValue: mockExpensesService },
      ],
    }).compile();
    service = moduleRef.get(FinancialFactsService);
  });

  describe("getForecastMonthlyIncome", () => {
    it("wraps IncomeService.monthlyForecast() and labels it basis FORECAST", async () => {
      mockIncomeService.monthlyForecast.mockResolvedValue(75000);

      const fact = await service.getForecastMonthlyIncome("user-1");

      expect(fact.value).toBe("75000.00");
      expect(fact.basis).toBe("FORECAST");
      expect(fact.metric).toBe("forecastMonthlyIncome");
      expect(fact.sourceTypes).toEqual(["Income"]);
    });
  });

  describe("getActualMonthlyIncome", () => {
    it("sums only Income rows dated within the target month, labeled basis ACTUAL", async () => {
      mockIncomeService.list.mockResolvedValue([
        { amount: 50000, receivedAt: new Date("2026-07-15") },
        { amount: 20000, receivedAt: new Date("2026-06-30") }, // outside target month
      ]);

      const fact = await service.getActualMonthlyIncome("user-1", "2026-07");

      expect(fact.value).toBe("50000.00");
      expect(fact.basis).toBe("ACTUAL");
      expect(fact.confidence).toBe("HIGH");
    });

    it("defaults to the current month when none is given", async () => {
      mockIncomeService.list.mockResolvedValue([]);

      const fact = await service.getActualMonthlyIncome("user-1");

      expect(fact.value).toBe("0.00");
    });

    it("rejects a malformed month string", async () => {
      await expect(service.getActualMonthlyIncome("user-1", "not-a-month")).rejects.toThrow();
    });
  });

  describe("getActualMonthlyExpenses", () => {
    it("sums this month's Expense rows, labeled basis ACTUAL", async () => {
      mockExpensesService.list.mockResolvedValue([{ amount: 12000 }, { amount: 3000 }]);

      const fact = await service.getActualMonthlyExpenses("user-1", "2026-07");

      expect(fact.value).toBe("15000.00");
      expect(fact.basis).toBe("ACTUAL");
      expect(mockExpensesService.list).toHaveBeenCalledWith("user-1", "2026-07");
    });
  });

  describe("getForecastMonthlyExpenses", () => {
    it("averages the trailing 3 months of actual expense totals, labeled basis FORECAST", async () => {
      // Three calls to getActualMonthlyExpenses -> expensesService.list, one per
      // trailing month; mockResolvedValueOnce in call order (most-recent-first, per
      // monthsBefore(currentMonth, 1|2|3)).
      mockExpensesService.list
        .mockResolvedValueOnce([{ amount: 10000 }]) // 1 month ago
        .mockResolvedValueOnce([{ amount: 20000 }]) // 2 months ago
        .mockResolvedValueOnce([{ amount: 30000 }]); // 3 months ago

      const fact = await service.getForecastMonthlyExpenses("user-1");

      expect(fact.value).toBe("20000.00"); // (10000+20000+30000)/3
      expect(fact.basis).toBe("FORECAST");
      expect(fact.confidence).toBe("MEDIUM");
    });

    it("excludes zero-data months from the average instead of dragging it toward 0", async () => {
      mockExpensesService.list
        .mockResolvedValueOnce([{ amount: 10000 }])
        .mockResolvedValueOnce([]) // no data this month
        .mockResolvedValueOnce([]); // no data this month either

      const fact = await service.getForecastMonthlyExpenses("user-1");

      expect(fact.value).toBe("10000.00");
      expect(fact.confidence).toBe("LOW"); // fewer than 2 non-zero months backing it
    });

    it("returns 0 with LOW confidence when there is no expense history at all", async () => {
      mockExpensesService.list.mockResolvedValue([]);

      const fact = await service.getForecastMonthlyExpenses("user-1");

      expect(fact.value).toBe("0.00");
      expect(fact.confidence).toBe("LOW");
    });
  });

  describe("getEmergencyFundStatus", () => {
    it("prefers EMERGENCY_FUND goal(s) over the legacy category match", async () => {
      const status = await service.getEmergencyFundStatus("user-1", 1000, {
        emergencyFundGoals: [{ currentAmount: 4000 }, { currentAmount: 2000 }],
        monthExpenses: [{ amount: 999, category: { name: "Emergency Fund" } }],
      });

      expect(status.basis).toBe("GOAL");
      expect(status.amount).toBe(6000);
      expect(status.monthsOfCoverage).toBeCloseTo(72, 0); // 6000 / (1000/12)
    });

    it("falls back to the legacy category match when no goal exists", async () => {
      const status = await service.getEmergencyFundStatus("user-1", 1000, {
        emergencyFundGoals: [],
        monthExpenses: [{ amount: 3000, category: { name: "Emergency Fund" } }],
      });

      expect(status.basis).toBe("CATEGORY_LEGACY");
      expect(status.amount).toBe(3000);
    });

    it("returns basis NONE when neither signal exists", async () => {
      const status = await service.getEmergencyFundStatus("user-1", 1000, {
        emergencyFundGoals: [],
        monthExpenses: [{ amount: 500, category: { name: "Rent" } }],
      });

      expect(status.basis).toBe("NONE");
      expect(status.amount).toBe(0);
      expect(status.monthsOfCoverage).toBe(0);
    });

    it("fetches goals/expenses itself when not given prefetched data", async () => {
      mockPrisma.client.goal.findMany.mockResolvedValue([{ currentAmount: 5000 }]);
      mockExpensesService.list.mockResolvedValue([]);

      const status = await service.getEmergencyFundStatus("user-1", 1000);

      expect(status.basis).toBe("GOAL");
      expect(status.amount).toBe(5000);
      expect(mockPrisma.client.goal.findMany).toHaveBeenCalledWith({
        where: { userId: "user-1", type: "EMERGENCY_FUND" },
      });
    });
  });

  describe("getEmergencyFundStatusFact", () => {
    it("wraps getEmergencyFundStatus() as a FinancialFactDTO with basis-appropriate confidence", async () => {
      const fact = await service.getEmergencyFundStatusFact("user-1", 1000, {
        emergencyFundGoals: [{ currentAmount: 6000 }],
        monthExpenses: [],
      });

      expect(fact.metric).toBe("emergencyFundMonthsOfCoverage");
      expect(fact.confidence).toBe("HIGH");
      expect(fact.sourceTypes).toEqual(["Goal"]);
    });
  });
});
