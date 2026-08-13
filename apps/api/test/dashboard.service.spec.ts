import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
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
  // Was a bare `{}` — getSummary() now also reads budgets via
  // this.prisma.client.budget.findMany(). Defaulted to "no budgets configured" so all
  // 4 pre-existing tests below (none of which ever mention budgets) keep computing the
  // health score via the redistributed-weight path, exactly matching what should
  // happen for an account that hasn't set any budgets up.
  // Also now reads goal.findMany() for the #2/#18 fixes below — defaulted to "no
  // goals" so these pre-existing tests exercise the exact original legacy behavior
  // (category-name-matched emergency fund, uncommittedCash === cashBalance).
  const mockPrisma = {
    client: {
      budget: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
      goal: { findMany: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInvestmentsService.totalCurrentValue.mockResolvedValue(0);
    mockLoansService.totalOutstanding.mockResolvedValue(0);
    mockLoansService.debtSummary.mockResolvedValue({ totalMonthlyEmi: "0", debtStressScore: 0, totalOutstanding: "0", loans: [] });
    mockAlertsService.refresh.mockResolvedValue([]);
    mockPropertyService.totalCurrentValue.mockResolvedValue(0);
    mockPrisma.client.budget.findMany.mockResolvedValue([]);
    mockPrisma.client.goal.findMany.mockResolvedValue([]);

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
    // New field: no budgets configured in this test, so the score was computed with
    // the budget dimension's weight redistributed across the other three, not from a
    // fabricated number.
    expect(summary.healthScore.budgetAdherenceIsReal).toBe(false);
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

describe("DashboardService budget-aware health score (new)", () => {
  let service: DashboardService;

  const mockIncomeService = { monthlyForecast: jest.fn(), list: jest.fn() };
  const mockExpensesService = { list: jest.fn() };
  const mockInvestmentsService = { totalCurrentValue: jest.fn().mockResolvedValue(0) };
  const mockLoansService = {
    totalOutstanding: jest.fn().mockResolvedValue(0),
    debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "0", debtStressScore: 0, totalOutstanding: "0", loans: [] }),
  };
  const mockAlertsService = { refresh: jest.fn().mockResolvedValue([]) };
  const mockPropertyService = { totalCurrentValue: jest.fn().mockResolvedValue(0) };
  const mockPrisma = {
    client: {
      budget: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
      goal: { findMany: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInvestmentsService.totalCurrentValue.mockResolvedValue(0);
    mockLoansService.totalOutstanding.mockResolvedValue(0);
    mockLoansService.debtSummary.mockResolvedValue({ totalMonthlyEmi: "0", debtStressScore: 0, totalOutstanding: "0", loans: [] });
    mockAlertsService.refresh.mockResolvedValue([]);
    mockPropertyService.totalCurrentValue.mockResolvedValue(0);
    mockIncomeService.monthlyForecast.mockResolvedValue(100000);
    mockIncomeService.list.mockResolvedValue([{ amount: 100000 }]);
    mockPrisma.client.goal.findMany.mockResolvedValue([]);

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

  it("gives full budget credit (score 100, isReal true) when spending is at or under every budget", async () => {
    mockExpensesService.list.mockResolvedValue([
      { amount: 15000, categoryId: "c1", category: { name: "Groceries", type: "NEED" } },
    ]);
    mockPrisma.client.budget.findMany.mockResolvedValue([{ categoryId: "c1", monthlyAmount: 20000 }]);

    const summary = await service.getSummary("user-1");

    expect(summary.healthScore.budgetAdherenceIsReal).toBe(true);
    expect(summary.healthScore.breakdown.budgetAdherence).toBe(100);
  });

  it("degrades the budget score proportionally to overspend, and it's included in the overall score", async () => {
    mockExpensesService.list.mockResolvedValue([
      { amount: 30000, categoryId: "c1", category: { name: "Dining Out", type: "WANT" } }, // 50% over a 20000 budget
    ]);
    mockPrisma.client.budget.findMany.mockResolvedValue([{ categoryId: "c1", monthlyAmount: 20000 }]);

    const summary = await service.getSummary("user-1");

    // adherence = 1 - (30000-20000)/20000 = 0.5 -> budgetScore = 50
    expect(summary.healthScore.breakdown.budgetAdherence).toBe(50);
    expect(summary.healthScore.budgetAdherenceIsReal).toBe(true);
  });

  it("weights multiple budgets' adherence by their amount, not a simple average", async () => {
    mockExpensesService.list.mockResolvedValue([
      { amount: 30000, categoryId: "rent", category: { name: "Rent", type: "NEED" } }, // exactly at a 30000 rent budget -> 100
      { amount: 1000, categoryId: "coffee", category: { name: "Coffee", type: "WANT" } }, // 900% over a tiny 100 budget -> floored at 0
    ]);
    mockPrisma.client.budget.findMany.mockResolvedValue([
      { categoryId: "rent", monthlyAmount: 30000 }, // large weight
      { categoryId: "coffee", monthlyAmount: 100 }, // tiny weight
    ]);

    const summary = await service.getSummary("user-1");

    // Weighted heavily toward the large, fully-met rent budget rather than being
    // dragged down evenly by the small, badly-blown coffee budget.
    expect(summary.healthScore.breakdown.budgetAdherence).toBeGreaterThan(90);
  });

  it("does not weight the budget dimension into the overall score at all when no budgets exist", async () => {
    mockExpensesService.list.mockResolvedValue([{ amount: 20000, categoryId: "c1", category: { name: "Rent", type: "NEED" } }]);
    mockPrisma.client.budget.findMany.mockResolvedValue([]);

    const summary = await service.getSummary("user-1");

    expect(summary.healthScore.budgetAdherenceIsReal).toBe(false);
  });
});

describe("DashboardService budget CRUD (new)", () => {
  let service: DashboardService;
  const mockPrisma = { client: { budget: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() } } };
  const noop = {};

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: noop },
        { provide: ExpensesService, useValue: noop },
        { provide: InvestmentsService, useValue: noop },
        { provide: LoansService, useValue: noop },
        { provide: AlertsService, useValue: noop },
        { provide: PropertyService, useValue: noop },
      ],
    }).compile();
    service = moduleRef.get(DashboardService);
  });

  it("lists a user's budgets", async () => {
    mockPrisma.client.budget.findMany.mockResolvedValue([{ id: "b1", categoryId: "c1", monthlyAmount: 20000 }]);

    const budgets = await service.listBudgets("user-1");

    expect(budgets).toHaveLength(1);
    expect(mockPrisma.client.budget.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
  });

  it("upserts a budget keyed by (userId, categoryId)", async () => {
    mockPrisma.client.budget.upsert.mockResolvedValue({ id: "b1", categoryId: "c1", monthlyAmount: 25000 });

    await service.upsertBudget("user-1", { categoryId: "c1", monthlyAmount: 25000 });

    expect(mockPrisma.client.budget.upsert).toHaveBeenCalledWith({
      where: { userId_categoryId: { userId: "user-1", categoryId: "c1" } },
      create: { userId: "user-1", categoryId: "c1", monthlyAmount: 25000 },
      update: { monthlyAmount: 25000 },
      include: { category: true },
    });
  });

  it("removes a budget scoped to the owner", async () => {
    mockPrisma.client.budget.deleteMany.mockResolvedValue({ count: 1 });

    const result = await service.removeBudget("user-1", "b1");

    expect(mockPrisma.client.budget.deleteMany).toHaveBeenCalledWith({ where: { id: "b1", userId: "user-1" } });
    expect(result).toEqual({ id: "b1" });
  });

  it("throws NotFoundException removing a budget that doesn't exist or isn't owned by the caller", async () => {
    mockPrisma.client.budget.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.removeBudget("user-1", "not-mine")).rejects.toThrow(NotFoundException);
  });
});

describe("DashboardService emergency fund via Goal + uncommitted cash (new, audit items #2 and #18)", () => {
  let service: DashboardService;

  const mockIncomeService = { monthlyForecast: jest.fn(), list: jest.fn() };
  const mockExpensesService = { list: jest.fn() };
  const mockInvestmentsService = { totalCurrentValue: jest.fn().mockResolvedValue(0) };
  const mockLoansService = {
    totalOutstanding: jest.fn().mockResolvedValue(0),
    debtSummary: jest.fn().mockResolvedValue({ totalMonthlyEmi: "0", debtStressScore: 0, totalOutstanding: "0", loans: [] }),
  };
  const mockAlertsService = { refresh: jest.fn().mockResolvedValue([]) };
  const mockPropertyService = { totalCurrentValue: jest.fn().mockResolvedValue(0) };
  const mockPrisma = {
    client: {
      budget: { findMany: jest.fn().mockResolvedValue([]) },
      goal: { findMany: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInvestmentsService.totalCurrentValue.mockResolvedValue(0);
    mockLoansService.totalOutstanding.mockResolvedValue(0);
    mockLoansService.debtSummary.mockResolvedValue({ totalMonthlyEmi: "0", debtStressScore: 0, totalOutstanding: "0", loans: [] });
    mockAlertsService.refresh.mockResolvedValue([]);
    mockPropertyService.totalCurrentValue.mockResolvedValue(0);
    mockPrisma.client.budget.findMany.mockResolvedValue([]);
    // Monthly expense total of 12000 -> monthly-equivalent of 1000, so a 6000 reserve
    // == exactly 6 months, a clean number to assert against.
    mockIncomeService.monthlyForecast.mockResolvedValue(50000);
    mockIncomeService.list.mockResolvedValue([{ amount: 50000 }]);
    mockExpensesService.list.mockResolvedValue([{ amount: 12000, categoryId: "c1", category: { name: "Rent", type: "NEED" } }]);

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

  it("uses an EMERGENCY_FUND goal's currentAmount, not a literally-named expense category, when a goal exists", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([
      { id: "g1", type: "EMERGENCY_FUND", currentAmount: 6000, investments: [] },
    ]);

    const summary = await service.getSummary("user-1");

    expect(summary.emergencyFundBasis).toBe("GOAL");
    expect(summary.emergencyFundAmount).toBe("6000.00");
    expect(summary.healthScore.breakdown.emergencyFundMonths).toBe(100); // 6 months / 6 -> capped at 100
  });

  it("sums currentAmount across multiple EMERGENCY_FUND goals", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([
      { id: "g1", type: "EMERGENCY_FUND", currentAmount: 2000, investments: [] },
      { id: "g2", type: "EMERGENCY_FUND", currentAmount: 1000, investments: [] },
      { id: "g3", type: "HOUSE", currentAmount: 500000, investments: [] }, // not counted
    ]);

    const summary = await service.getSummary("user-1");

    expect(summary.emergencyFundBasis).toBe("GOAL");
    expect(summary.emergencyFundAmount).toBe("3000.00");
  });

  it("falls back to the legacy 'Emergency Fund'-named expense category when no goal exists", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([]);
    mockExpensesService.list.mockResolvedValue([
      { amount: 12000, categoryId: "c1", category: { name: "Rent", type: "NEED" } },
      { amount: 3000, categoryId: "c2", category: { name: "Emergency Fund", type: "SAVINGS" } },
    ]);

    const summary = await service.getSummary("user-1");

    expect(summary.emergencyFundBasis).toBe("CATEGORY_LEGACY");
    expect(summary.emergencyFundAmount).toBe("3000.00");
  });

  it("reports basis NONE and a zero emergency-fund amount when neither a goal nor the legacy category exists", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([]);

    const summary = await service.getSummary("user-1");

    expect(summary.emergencyFundBasis).toBe("NONE");
    expect(summary.emergencyFundAmount).toBe("0.00");
    expect(summary.healthScore.breakdown.emergencyFundMonths).toBe(0);
  });

  it("prefers the GOAL basis over the legacy category even if both are present", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([
      { id: "g1", type: "EMERGENCY_FUND", currentAmount: 9000, investments: [] },
    ]);
    mockExpensesService.list.mockResolvedValue([
      { amount: 3000, categoryId: "c2", category: { name: "Emergency Fund", type: "SAVINGS" } },
    ]);

    const summary = await service.getSummary("user-1");

    expect(summary.emergencyFundBasis).toBe("GOAL");
    expect(summary.emergencyFundAmount).toBe("9000.00");
  });

  it("subtracts non-investment-backed goal currentAmount from cashBalance to get uncommittedCash", async () => {
    mockIncomeService.list.mockResolvedValue([{ amount: 100000 }]);
    mockExpensesService.list.mockResolvedValue([{ amount: 20000, categoryId: "c1", category: { name: "Rent", type: "NEED" } }]);
    mockPrisma.client.goal.findMany.mockResolvedValue([
      { id: "g1", type: "EMERGENCY_FUND", currentAmount: 15000, investments: [] }, // cash-backed, subtracted
      { id: "g2", type: "HOUSE", currentAmount: 200000, investments: [{ id: "inv1" }] }, // investment-backed, NOT subtracted
    ]);

    const summary = await service.getSummary("user-1");

    // cashBalance = 100000 - 20000 = 80000; uncommittedCash = 80000 - 15000 (g1 only) = 65000
    expect(summary.cashBalance).toBe("80000.00");
    expect(summary.uncommittedCash).toBe("65000.00");
  });

  it("uncommittedCash equals cashBalance when the user has no goals at all", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([]);
    mockIncomeService.list.mockResolvedValue([{ amount: 40000 }]);
    mockExpensesService.list.mockResolvedValue([{ amount: 10000, categoryId: "c1", category: { name: "Rent", type: "NEED" } }]);

    const summary = await service.getSummary("user-1");

    expect(summary.uncommittedCash).toBe(summary.cashBalance);
  });
});
