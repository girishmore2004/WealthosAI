import { Test } from "@nestjs/testing";
import { ReportsService } from "../src/reports/reports.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { InvestmentsService } from "../src/investments/investments.service";
import { LoansService } from "../src/loans/loans.service";
import { BusinessService } from "../src/business/business.service";

describe("ReportsService", () => {
  let service: ReportsService;

  const mockPrisma = { client: { expense: { findMany: jest.fn() } } };
  const mockIncomeService = { list: jest.fn() };
  const mockExpensesService = { list: jest.fn() };
  const mockInvestmentsService = { summary: jest.fn() };
  const mockLoansService = { debtSummary: jest.fn() };
  const mockBusinessService = { annualProfitForUser: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncomeService },
        { provide: ExpensesService, useValue: mockExpensesService },
        { provide: InvestmentsService, useValue: mockInvestmentsService },
        { provide: LoansService, useValue: mockLoansService },
        { provide: BusinessService, useValue: mockBusinessService },
      ],
    }).compile();
    service = moduleRef.get(ReportsService);
  });

  describe("monthlyReport", () => {
    it("computes savings rate and category percentages that sum to 100", async () => {
      mockIncomeService.list.mockResolvedValue([
        { amount: 90000, receivedAt: new Date("2026-07-01") },
        { amount: 10000, receivedAt: new Date("2026-06-15") }, // outside target month, must be excluded
      ]);
      mockExpensesService.list.mockResolvedValue([
        { amount: 30000, category: { name: "Rent" } },
        { amount: 20000, category: { name: "Groceries" } },
      ]);

      const report = await service.monthlyReport("user-1", "2026-07");

      expect(report.income).toBe("90000.00");
      expect(report.expenses).toBe("50000.00");
      expect(report.netCashflow).toBe("40000.00");
      expect(report.savingsRate).toBeCloseTo((40000 / 90000) * 100, 1);

      const totalPercent = report.expensesByCategory.reduce((sum, c) => sum + c.percentOfTotal, 0);
      expect(totalPercent).toBeCloseTo(100, 0);
    });

    it("does not divide by zero when there is no income logged for the month", async () => {
      mockIncomeService.list.mockResolvedValue([]);
      mockExpensesService.list.mockResolvedValue([{ amount: 5000, category: { name: "Groceries" } }]);

      const report = await service.monthlyReport("user-1", "2026-07");

      expect(report.savingsRate).toBe(0);
      expect(report.income).toBe("0.00");
    });
  });

  describe("yearlyReport", () => {
    it("includes income/expenses only within the April-March financial year window", async () => {
      mockIncomeService.list.mockResolvedValue([
        { amount: 100000, receivedAt: new Date("2026-04-01") }, // in FY2026-27
        { amount: 50000, receivedAt: new Date("2027-03-31") }, // in FY2026-27
        { amount: 999999, receivedAt: new Date("2026-03-31") }, // just before FY2026-27 starts
        { amount: 888888, receivedAt: new Date("2027-04-01") }, // just after FY2026-27 ends
      ]);
      mockPrisma.client.expense.findMany.mockResolvedValue([]);
      mockInvestmentsService.summary.mockResolvedValue({ totalCurrentValue: "0.00" });
      mockLoansService.debtSummary.mockResolvedValue({ totalOutstanding: "0.00" });
      mockBusinessService.annualProfitForUser.mockResolvedValue(null);

      const report = await service.yearlyReport("user-1", "2026-27");

      expect(report.totalIncome).toBe("150000.00");
      expect(report.businessProfit).toBeNull();
    });
  });
});
