import { Test } from "@nestjs/testing";
import { AlertsService } from "../src/alerts/alerts.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { LoansService } from "../src/loans/loans.service";
import { InsuranceService } from "../src/insurance/insurance.service";
import { GoalsService } from "../src/goals/goals.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { BusinessService } from "../src/business/business.service";
import { DocumentsService } from "../src/documents/documents.service";
import { IncomeService } from "../src/income/income.service";

describe("AlertsService.refresh", () => {
  let service: AlertsService;

  const mockPrisma = {
    client: {
      alert: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
  };
  const mockLoansService = { list: jest.fn(), debtSummary: jest.fn() };
  const mockInsuranceService = { upcomingRenewals: jest.fn() };
  const mockGoalsService = { list: jest.fn() };
  const mockExpensesService = { detectSubscriptions: jest.fn(), categoryBreakdown: jest.fn() };
  const mockBusinessService = { upcomingObligationsForUser: jest.fn().mockResolvedValue([]) };
  const mockDocumentsService = { expiringSoon: jest.fn().mockResolvedValue([]) };
  const mockIncomeService = { monthlyForecast: jest.fn().mockResolvedValue(0) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.alert.findMany.mockResolvedValue([]);
    mockBusinessService.upcomingObligationsForUser.mockResolvedValue([]);
    mockDocumentsService.expiringSoon.mockResolvedValue([]);
    mockIncomeService.monthlyForecast.mockResolvedValue(0);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LoansService, useValue: mockLoansService },
        { provide: InsuranceService, useValue: mockInsuranceService },
        { provide: GoalsService, useValue: mockGoalsService },
        { provide: ExpensesService, useValue: mockExpensesService },
        { provide: BusinessService, useValue: mockBusinessService },
        { provide: DocumentsService, useValue: mockDocumentsService },
        { provide: IncomeService, useValue: mockIncomeService },
      ],
    }).compile();
    service = moduleRef.get(AlertsService);
  });

  it("raises a CRITICAL debt-stress alert when EMIs exceed 60% of income", async () => {
    mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
    mockLoansService.list.mockResolvedValue([]);
    mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 65 });
    mockGoalsService.list.mockResolvedValue([]);
    mockExpensesService.detectSubscriptions.mockResolvedValue([]);
    mockExpensesService.categoryBreakdown.mockResolvedValue([]);

    await service.refresh("user-1");

    const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
    const debtAlert = upsertCalls.find((c) => c[0].create.type === "DEBT_STRESS");
    expect(debtAlert?.[0].create.severity).toBe("CRITICAL");
  });

  it("raises a GOAL_DELAY alert for off-track goals but not on-track ones", async () => {
    mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
    mockLoansService.list.mockResolvedValue([]);
    mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 10 });
    mockGoalsService.list.mockResolvedValue([
      { id: "g1", name: "Emergency fund", probabilityOfSuccess: "OFF_TRACK", requiredMonthlyContribution: 5000 },
      { id: "g2", name: "Vacation", probabilityOfSuccess: "ON_TRACK", requiredMonthlyContribution: 2000 },
    ]);
    mockExpensesService.detectSubscriptions.mockResolvedValue([]);
    mockExpensesService.categoryBreakdown.mockResolvedValue([]);

    await service.refresh("user-1");

    const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
    const goalAlerts = upsertCalls.filter((c) => c[0].create.type === "GOAL_DELAY");
    expect(goalAlerts).toHaveLength(1);
    expect(goalAlerts[0][0].create.dedupeKey).toBe("goal-delay-g1");
  });

  it("prunes unread alerts whose dedupe key is no longer active", async () => {
    mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
    mockLoansService.list.mockResolvedValue([]);
    mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 0 });
    mockGoalsService.list.mockResolvedValue([]);
    mockExpensesService.detectSubscriptions.mockResolvedValue([]);
    mockExpensesService.categoryBreakdown.mockResolvedValue([]);

    await service.refresh("user-1");

    expect(mockPrisma.client.alert.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", isRead: false, dedupeKey: { notIn: [] } }),
      }),
    );
  });

  it("raises DOCUMENT_EXPIRY and BUSINESS_OBLIGATION_DUE alerts from linked modules", async () => {
    mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
    mockLoansService.list.mockResolvedValue([]);
    mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 0 });
    mockGoalsService.list.mockResolvedValue([]);
    mockExpensesService.detectSubscriptions.mockResolvedValue([]);
    mockExpensesService.categoryBreakdown.mockResolvedValue([]);
    mockDocumentsService.expiringSoon.mockResolvedValue([
      { id: "doc1", fileName: "Health Insurance.pdf", category: "INSURANCE_POLICY", expiryDate: new Date("2026-08-01") },
    ]);
    mockBusinessService.upcomingObligationsForUser.mockResolvedValue([
      { id: "ob1", title: "GST filing", dueDate: new Date("2026-07-20"), amount: 5000, business: { name: "Sunil Studio" } },
    ]);

    await service.refresh("user-1");

    const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
    const docAlert = upsertCalls.find((c) => c[0].create.type === "DOCUMENT_EXPIRY");
    const obligationAlert = upsertCalls.find((c) => c[0].create.type === "BUSINESS_OBLIGATION_DUE");

    expect(docAlert?.[0].create.dedupeKey).toBe("document-expiry-doc1");
    expect(obligationAlert?.[0].create.dedupeKey).toBe("business-obligation-ob1");
    expect(obligationAlert?.[0].create.title).toContain("Sunil Studio");
  });

  it("skips a DOCUMENT_EXPIRY candidate defensively if expiryDate is somehow null", async () => {
    mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
    mockLoansService.list.mockResolvedValue([]);
    mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 0 });
    mockGoalsService.list.mockResolvedValue([]);
    mockExpensesService.detectSubscriptions.mockResolvedValue([]);
    mockExpensesService.categoryBreakdown.mockResolvedValue([]);
    mockDocumentsService.expiringSoon.mockResolvedValue([
      { id: "doc-bad", fileName: "Corrupted.pdf", category: "OTHER", expiryDate: null },
    ]);

    await service.refresh("user-1");

    const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
    expect(upsertCalls.find((c) => c[0].create.type === "DOCUMENT_EXPIRY")).toBeUndefined();
  });

  describe("BUDGET_OVERSPEND — income-relative threshold", () => {
    it("does NOT fire for a WANT category under 20% of monthly income", async () => {
      mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
      mockLoansService.list.mockResolvedValue([]);
      mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 0 });
      mockGoalsService.list.mockResolvedValue([]);
      mockExpensesService.detectSubscriptions.mockResolvedValue([]);
      mockIncomeService.monthlyForecast.mockResolvedValue(100000); // ₹1L/month income
      mockExpensesService.categoryBreakdown.mockResolvedValue([
        { categoryId: "c1", name: "Dining Out", type: "WANT", total: 10000 }, // 10% of income
      ]);

      await service.refresh("user-1");

      const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
      expect(upsertCalls.find((c) => c[0].create.type === "BUDGET_OVERSPEND")).toBeUndefined();
    });

    it("fires WARNING at 20%+ of income and CRITICAL at 30%+", async () => {
      mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
      mockLoansService.list.mockResolvedValue([]);
      mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 0 });
      mockGoalsService.list.mockResolvedValue([]);
      mockExpensesService.detectSubscriptions.mockResolvedValue([]);
      mockIncomeService.monthlyForecast.mockResolvedValue(100000); // ₹1L/month income
      mockExpensesService.categoryBreakdown.mockResolvedValue([
        { categoryId: "c1", name: "Dining Out", type: "WANT", total: 25000 }, // 25% → WARNING
        { categoryId: "c2", name: "Shopping", type: "WANT", total: 35000 }, // 35% → CRITICAL
        { categoryId: "c3", name: "Rent", type: "NEED", total: 40000 }, // NEED, never fires
      ]);

      await service.refresh("user-1");

      const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
      const overspendAlerts = upsertCalls.filter((c) => c[0].create.type === "BUDGET_OVERSPEND");
      expect(overspendAlerts).toHaveLength(2);

      const dining = overspendAlerts.find((c) => c[0].create.dedupeKey.startsWith("budget-overspend-c1-"));
      const shopping = overspendAlerts.find((c) => c[0].create.dedupeKey.startsWith("budget-overspend-c2-"));
      expect(dining?.[0].create.severity).toBe("WARNING");
      expect(shopping?.[0].create.severity).toBe("CRITICAL");
    });

    it("falls back to the absolute ₹15,000 threshold when the user has no income logged", async () => {
      mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
      mockLoansService.list.mockResolvedValue([]);
      mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 0 });
      mockGoalsService.list.mockResolvedValue([]);
      mockExpensesService.detectSubscriptions.mockResolvedValue([]);
      mockIncomeService.monthlyForecast.mockResolvedValue(0);
      mockExpensesService.categoryBreakdown.mockResolvedValue([
        { categoryId: "c1", name: "Dining Out", type: "WANT", total: 16000 },
      ]);

      await service.refresh("user-1");

      const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
      expect(upsertCalls.find((c) => c[0].create.type === "BUDGET_OVERSPEND")).toBeDefined();
    });
  });

  describe("EMI_DUE — date correctness", () => {
    it("still raises an alert for an EMI due exactly today", async () => {
      const fixedNow = new Date("2026-07-15T18:30:00.000Z"); // afternoon, same day as the EMI due date
      jest.useFakeTimers().setSystemTime(fixedNow);

      mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
      mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 0 });
      mockGoalsService.list.mockResolvedValue([]);
      mockExpensesService.detectSubscriptions.mockResolvedValue([]);
      mockExpensesService.categoryBreakdown.mockResolvedValue([]);
      mockLoansService.list.mockResolvedValue([
        { id: "loan1", lender: "HDFC", emiAmount: 12000, startDate: new Date("2025-01-15") },
      ]);

      await service.refresh("user-1");

      const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
      const emiAlert = upsertCalls.find((c) => c[0].create.type === "EMI_DUE");
      expect(emiAlert).toBeDefined();
      expect(emiAlert?.[0].create.severity).toBe("WARNING"); // due today, within the WARNING window

      jest.useRealTimers();
    });

    it("clamps a 31st-of-month due date correctly in a 30-day month", async () => {
      const fixedNow = new Date("2026-04-25T10:00:00.000Z"); // April has 30 days
      jest.useFakeTimers().setSystemTime(fixedNow);

      mockInsuranceService.upcomingRenewals.mockResolvedValue([]);
      mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 0 });
      mockGoalsService.list.mockResolvedValue([]);
      mockExpensesService.detectSubscriptions.mockResolvedValue([]);
      mockExpensesService.categoryBreakdown.mockResolvedValue([]);
      mockLoansService.list.mockResolvedValue([
        { id: "loan1", lender: "ICICI", emiAmount: 9000, startDate: new Date("2025-01-31") },
      ]);

      await service.refresh("user-1");

      const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
      const emiAlert = upsertCalls.find((c) => c[0].create.type === "EMI_DUE");
      expect(emiAlert).toBeDefined();
      // Must clamp to April 30, not overflow into May 1.
      expect(emiAlert?.[0].create.dueDate.toISOString().slice(0, 10)).toBe("2026-04-30");

      jest.useRealTimers();
    });
  });

  it("does not fail the whole refresh when one upstream data source rejects", async () => {
    mockInsuranceService.upcomingRenewals.mockRejectedValue(new Error("insurance service down"));
    mockLoansService.list.mockResolvedValue([]);
    mockLoansService.debtSummary.mockResolvedValue({ debtStressScore: 65 });
    mockGoalsService.list.mockResolvedValue([]);
    mockExpensesService.detectSubscriptions.mockResolvedValue([]);
    mockExpensesService.categoryBreakdown.mockResolvedValue([]);

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(service.refresh("user-1")).resolves.toBeDefined();

    const upsertCalls = mockPrisma.client.alert.upsert.mock.calls;
    // DEBT_STRESS still fires even though INSURANCE_RENEWAL's source failed.
    expect(upsertCalls.find((c) => c[0].create.type === "DEBT_STRESS")).toBeDefined();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
