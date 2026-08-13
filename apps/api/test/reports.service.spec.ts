import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ReportsService } from "../src/reports/reports.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { InvestmentsService } from "../src/investments/investments.service";
import { LoansService } from "../src/loans/loans.service";
import { BusinessService } from "../src/business/business.service";
import { FinancialFactsService } from "../src/common/financial-facts/financial-facts.service";

describe("ReportsService", () => {
  let service: ReportsService;

  const mockPrisma = { client: { expense: { findMany: jest.fn() }, goal: { findMany: jest.fn() } } };
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
        // Real FinancialFactsService (audit item #1), not a mock — monthlyReport() now
        // delegates its income figure to FinancialFactsService.getActualMonthlyIncome(),
        // which itself is built on the same mockIncomeService/mockPrisma above. Using
        // the real class here (rather than re-mocking its output) keeps this an
        // end-to-end test of the actual delegation, not just an assertion that a mock
        // was called.
        FinancialFactsService,
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
      // NEW (audit item #1): explicit basis labels so a caller never has to guess
      // whether this figure means the same thing as Dashboard's forecast-based one.
      expect(report.incomeBasis).toBe("ACTUAL");
      expect(report.expensesBasis).toBe("ACTUAL");

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

    it("rejects a malformed month instead of silently returning a zeroed report", async () => {
      await expect(service.monthlyReport("user-1", "2026-13")).rejects.toThrow(BadRequestException);
      await expect(service.monthlyReport("user-1", "july-2026")).rejects.toThrow(BadRequestException);
      expect(mockIncomeService.list).not.toHaveBeenCalled();
    });

    it("excludes income exactly at the exclusive end-of-month UTC boundary", async () => {
      mockIncomeService.list.mockResolvedValue([
        { amount: 5000, receivedAt: new Date("2026-07-31T23:59:59.999Z") }, // in July
        { amount: 7000, receivedAt: new Date("2026-08-01T00:00:00.000Z") }, // in August, must be excluded
      ]);
      mockExpensesService.list.mockResolvedValue([]);

      const report = await service.monthlyReport("user-1", "2026-07");

      expect(report.income).toBe("5000.00");
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

    it("rejects a malformed financial year instead of silently mis-ranging", async () => {
      await expect(service.yearlyReport("user-1", "2026")).rejects.toThrow(BadRequestException);
      await expect(service.yearlyReport("user-1", "FY26-27")).rejects.toThrow(BadRequestException);
      expect(mockIncomeService.list).not.toHaveBeenCalled();
    });
  });

  describe("monthlyReportCsv", () => {
    it("escapes category names containing commas so columns don't shift", async () => {
      mockIncomeService.list.mockResolvedValue([]);
      mockExpensesService.list.mockResolvedValue([{ amount: 1000, category: { name: "Food, Dining" } }]);

      const csv = await service.monthlyReportCsv("user-1", "2026-07");

      expect(csv).toContain('"Food, Dining",1000.00,100');
    });

    it("neutralizes a category name that looks like a spreadsheet formula", async () => {
      mockIncomeService.list.mockResolvedValue([]);
      mockExpensesService.list.mockResolvedValue([{ amount: 500, category: { name: "=cmd|'/c calc'!A1" } }]);

      const csv = await service.monthlyReportCsv("user-1", "2026-07");

      // Neither a raw `=` at the start of a cell nor an un-neutralized formula should
      // reach the output.
      expect(csv).not.toMatch(/,=cmd/);
      expect(csv).toContain("'=cmd|'/c calc'!A1");
    });

    it("does not mistake a negative net cashflow for a formula-injection risk", async () => {
      mockIncomeService.list.mockResolvedValue([{ amount: 1000, receivedAt: new Date("2026-07-05") }]);
      mockExpensesService.list.mockResolvedValue([{ amount: 5000, category: { name: "Rent" } }]);

      const csv = await service.monthlyReportCsv("user-1", "2026-07");

      expect(csv).toContain("Net Cashflow,-4000.00");
      expect(csv).not.toContain("'-4000.00");
    });
  });

  describe("yearlyReportCsv", () => {
    it("produces a full metric/value + category block for the financial year", async () => {
      mockIncomeService.list.mockResolvedValue([{ amount: 100000, receivedAt: new Date("2026-04-01") }]);
      mockPrisma.client.expense.findMany.mockResolvedValue([{ amount: 20000, category: { name: "Rent" } }]);
      mockInvestmentsService.summary.mockResolvedValue({ totalCurrentValue: "500000.00" });
      mockLoansService.debtSummary.mockResolvedValue({ totalOutstanding: "100000.00" });
      mockBusinessService.annualProfitForUser.mockResolvedValue(null);

      const csv = await service.yearlyReportCsv("user-1", "2026-27");

      expect(csv).toContain("Financial Year,2026-27");
      expect(csv).toContain("Total Income,100000.00");
      expect(csv).toContain("Business Profit,N/A");
      expect(csv).toContain("Rent,20000.00,100");
    });

    it("rejects a malformed financial year", async () => {
      await expect(service.yearlyReportCsv("user-1", "not-a-year")).rejects.toThrow(BadRequestException);
    });
  });
});
