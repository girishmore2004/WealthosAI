import { Test } from "@nestjs/testing";
import { DashboardService } from "../src/dashboard/dashboard.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { InvestmentsService } from "../src/investments/investments.service";
import { LoansService } from "../src/loans/loans.service";
import { AlertsService } from "../src/alerts/alerts.service";
import { PropertyService } from "../src/property/property.service";

describe("DashboardService.computeHealthScore (via getSummary)", () => {
  let service: DashboardService;

  const mockIncomeService = {
    monthlyForecast: jest.fn(),
    list: jest.fn(),
  };
  const mockExpensesService = {
    list: jest.fn(),
  };
  const mockInvestmentsService = {
    totalCurrentValue: jest.fn().mockResolvedValue(0),
  };
  const mockLoansService = {
    totalOutstanding: jest.fn().mockResolvedValue(0),
    debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "0", debtStressScore: 0, totalOutstanding: "0", loans: [] }),
  };
  const mockAlertsService = {
    refresh: jest.fn().mockResolvedValue([]),
  };
  const mockPropertyService = {
    totalCurrentValue: jest.fn().mockResolvedValue(0),
  };
  const mockPrisma = {};

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInvestmentsService.totalCurrentValue.mockResolvedValue(0);
    mockLoansService.totalOutstanding.mockResolvedValue(0);
    mockLoansService.debtSummary.mockResolvedValue({ totalMonthlyEmi: "0", debtStressScore: 0, totalOutstanding: "0", loans: [] });
    mockAlertsService.refresh.mockResolvedValue([]);
    mockPropertyService.totalCurrentValue.mockResolvedValue(0);

    const moduleRef = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncomeService },
        { provide: ExpensesService, useValue: mockExpensesService },
        { provide: InvestmentsService, useValue: mockInvestmentsService },
        { provide: LoansService, useValue: mockLoansService },
        { provide: AlertsService, useValue: mockAlertsService },
        { provide: PropertyService, useValue: mockPropertyService },
      ],
    }).compile();

    service = moduleRef.get(DashboardService);
  });

  it("scores a healthy month as STABLE or STRONG", async () => {
    mockIncomeService.monthlyForecast.mockResolvedValue(100000);
    mockIncomeService.list.mockResolvedValue([{ amount: 100000 }]);
    const expenses = [
      { amount: 20000, category: { name: "Rent", type: "NEED" } },
      { amount: 10000, category: { name: "EMI", type: "NEED" } },
      { amount: 5000, category: { name: "Dining Out", type: "WANT" } },
      { amount: 30000, category: { name: "Emergency Fund", type: "SAVINGS" } },
    ];
    mockExpensesService.list.mockResolvedValue(expenses);

    const summary = await service.getSummary("user-1");

    expect(summary.savingsRate).toBeGreaterThan(20);
    expect(["STABLE", "STRONG"]).toContain(summary.healthScore.band);
  });

  it("flags a low-savings month with a WARNING insight", async () => {
    mockIncomeService.monthlyForecast.mockResolvedValue(50000);
    mockIncomeService.list.mockResolvedValue([{ amount: 50000 }]);
    const expenses = [
      { amount: 25000, category: { name: "Rent", type: "NEED" } },
      { amount: 20000, category: { name: "Dining Out", type: "WANT" } },
    ];
    mockExpensesService.list.mockResolvedValue(expenses);

    const summary = await service.getSummary("user-1");

    expect(summary.insights.some((i) => i.id === "low-savings-rate")).toBe(true);
  });

  it("flags high EMI load relative to income as a debt-stress insight", async () => {
    mockIncomeService.monthlyForecast.mockResolvedValue(60000);
    mockIncomeService.list.mockResolvedValue([{ amount: 60000 }]);
    mockExpensesService.list.mockResolvedValue([{ amount: 10000, category: { name: "Rent", type: "NEED" } }]);
    mockLoansService.debtSummary.mockResolvedValue({
      totalMonthlyEmi: "35000",
      debtStressScore: 58.3,
      totalOutstanding: "1500000",
      loans: [],
    });

    const summary = await service.getSummary("user-1");

    const debtInsight = summary.insights.find((i) => i.id === "high-debt-stress");
    expect(debtInsight).toBeDefined();
    expect(debtInsight?.severity).toBe("CRITICAL");
  });

  it("includes property value as a net-worth asset alongside investments and debt", async () => {
    mockIncomeService.monthlyForecast.mockResolvedValue(80000);
    mockIncomeService.list.mockResolvedValue([{ amount: 80000 }]);
    mockExpensesService.list.mockResolvedValue([{ amount: 30000, category: { name: "Rent", type: "NEED" } }]);
    mockInvestmentsService.totalCurrentValue.mockResolvedValue(200000);
    mockLoansService.totalOutstanding.mockResolvedValue(1000000);
    mockPropertyService.totalCurrentValue.mockResolvedValue(4500000);

    const summary = await service.getSummary("user-1");

    // cashBalance here = totalIncomeAllTime(80000) - totalExpenseAllTime(30000) = 50000
    // netWorth = cashBalance + investments + property - debt
    expect(summary.propertyValue).toBe("4500000.00");
    expect(Number(summary.netWorth)).toBeCloseTo(50000 + 200000 + 4500000 - 1000000);
  });
});
