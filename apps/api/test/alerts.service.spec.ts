import { Test } from "@nestjs/testing";
import { AlertsService } from "../src/alerts/alerts.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { LoansService } from "../src/loans/loans.service";
import { InsuranceService } from "../src/insurance/insurance.service";
import { GoalsService } from "../src/goals/goals.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { BusinessService } from "../src/business/business.service";
import { DocumentsService } from "../src/documents/documents.service";

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

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.alert.findMany.mockResolvedValue([]);
    mockBusinessService.upcomingObligationsForUser.mockResolvedValue([]);
    mockDocumentsService.expiringSoon.mockResolvedValue([]);
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
});
