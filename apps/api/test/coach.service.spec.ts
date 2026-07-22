import { Test } from "@nestjs/testing";
import { CoachService } from "../src/coach/coach.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { GoalsService } from "../src/goals/goals.service";
import { TaxService } from "../src/tax/tax.service";
import { RetirementService } from "../src/retirement/retirement.service";
import { InsuranceService } from "../src/insurance/insurance.service";
import { InvestmentsService } from "../src/investments/investments.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { LoansService } from "../src/loans/loans.service";
import { IncomeService } from "../src/income/income.service";
import { DashboardService } from "../src/dashboard/dashboard.service";
import { AlertsService } from "../src/alerts/alerts.service";

describe("CoachService.ask", () => {
  let service: CoachService;

  const mockPrisma = {
    client: {
      coachInteraction: { create: jest.fn((args) => Promise.resolve({ id: "i1", ...args.data })) },
      user: { findUnique: jest.fn() },
    },
  };
  const mockGoals = { list: jest.fn() };
  const mockTax = { estimate: jest.fn() };
  const mockRetirement = { computePlan: jest.fn() };
  const mockInsurance = { gapAnalysis: jest.fn() };
  const mockInvestments = { summary: jest.fn(), totalCurrentValue: jest.fn() };
  const mockExpenses = { list: jest.fn(), categoryBreakdown: jest.fn(), detectSubscriptions: jest.fn() };
  const mockLoans = { debtSummary: jest.fn(), totalOutstanding: jest.fn() };
  const mockIncome = { list: jest.fn(), monthlyForecast: jest.fn() };
  const mockDashboard = { getSummary: jest.fn() };
  const mockAlerts = { list: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CoachService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: GoalsService, useValue: mockGoals },
        { provide: TaxService, useValue: mockTax },
        { provide: RetirementService, useValue: mockRetirement },
        { provide: InsuranceService, useValue: mockInsurance },
        { provide: InvestmentsService, useValue: mockInvestments },
        { provide: ExpensesService, useValue: mockExpenses },
        { provide: LoansService, useValue: mockLoans },
        { provide: IncomeService, useValue: mockIncome },
        { provide: DashboardService, useValue: mockDashboard },
        { provide: AlertsService, useValue: mockAlerts },
      ],
    }).compile();
    service = moduleRef.get(CoachService);
  });

  it("refuses an unrecognized question and lists supported topics, without calling any grounded service", async () => {
    const result = await service.ask("user-1", "what is the meaning of life");

    expect(result.wasRefused).toBe(true);
    expect(result.matchedIntent).toBeNull();
    expect(result.answer).toMatch(/net worth/i); // topic list is present in the refusal
    expect(mockGoals.list).not.toHaveBeenCalled();
    expect(mockTax.estimate).not.toHaveBeenCalled();
  });

  it("scopes a goals question to only the GoalsService, not other services", async () => {
    mockGoals.list.mockResolvedValue([
      { name: "Emergency fund", progressPercent: 40, probabilityOfSuccess: "AT_RISK" },
    ]);

    const result = await service.ask("user-1", "how are my goals doing?");

    expect(result.matchedIntent).toBe("GOALS");
    expect(result.wasRefused).toBe(false);
    expect(result.dataSources).toEqual(["goals"]);
    expect(result.answer).toContain("Emergency fund");
    expect(mockTax.estimate).not.toHaveBeenCalled();
    expect(mockInsurance.gapAnalysis).not.toHaveBeenCalled();
  });

  it("gives a graceful grounded answer (not a crash or refusal) when goals data is empty", async () => {
    mockGoals.list.mockResolvedValue([]);

    const result = await service.ask("user-1", "what are my goals");

    expect(result.wasRefused).toBe(false);
    expect(result.answer).toMatch(/haven't set any/i);
  });

  it("scopes a tax question to TaxService using the current financial year", async () => {
    mockTax.estimate.mockResolvedValue({
      financialYear: "2026-27",
      recommendedRegime: "NEW",
      savingsFromRecommendedRegime: "5000.00",
    });

    const result = await service.ask("user-1", "what's my tax looking like this year");

    expect(result.matchedIntent).toBe("TAX");
    expect(mockTax.estimate).toHaveBeenCalledWith("user-1", expect.stringMatching(/^\d{4}-\d{2}$/));
    expect(result.answer).toContain("new regime");
  });

  it("logs every interaction (including refusals) to CoachInteraction for audit", async () => {
    await service.ask("user-1", "gibberish query");

    expect(mockPrisma.client.coachInteraction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user-1", wasRefused: true, matchedIntent: null }),
      }),
    );
  });

  it("summarizes using the real DashboardService, scoped to the requesting user only", async () => {
    mockDashboard.getSummary.mockResolvedValue({
      netWorth: "500000.00", investmentsValue: "200000.00", totalDebt: "50000.00",
      savingsRate: 22.5, healthScore: { score: 78, band: "STABLE" }, unreadAlertCount: 2,
    });

    const result = await service.ask("user-42", "summarize my current situation");

    expect(mockDashboard.getSummary).toHaveBeenCalledWith("user-42");
    expect(result.matchedIntent).toBe("SUMMARY");
    expect(result.wasRefused).toBe(false);
    expect(result.answer).toContain("78/100");
  });

  it("recommends the highest-severity open alert for 'what should I do next'", async () => {
    mockAlerts.list.mockResolvedValue([
      { title: "Minor renewal", message: "info-level", severity: "INFO" },
      { title: "EMI overload", message: "debt stress is high", severity: "CRITICAL" },
    ]);

    const result = await service.ask("user-1", "what should i do next");

    expect(mockAlerts.list).toHaveBeenCalledWith("user-1", true);
    expect(result.matchedIntent).toBe("NEXT_ACTION");
    expect(result.answer).toContain("EMI overload"); // CRITICAL picked over INFO
  });

  it("returns insufficient-data (matched intent, but refused) for 'why did this change' since no historical snapshots are stored", async () => {
    mockAlerts.list.mockResolvedValue([]);

    const result = await service.ask("user-1", "why did my net worth change");

    expect(result.matchedIntent).toBe("WHY_CHANGED"); // recognized, not a generic refusal
    expect(result.wasRefused).toBe(true); // but genuinely can't be answered from the DB
    expect(result.answer).toMatch(/don't have enough historical data/i);
  });

  it("grounds the risk answer in the user's persisted riskProfile, not a guess", async () => {
    mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", riskProfile: "AGGRESSIVE" });
    mockInvestments.summary.mockResolvedValue({ allocation: [{ type: "STOCK", percent: 75 }] });
    mockLoans.debtSummary.mockResolvedValue({ debtStressScore: 12 });

    const result = await service.ask("user-1", "explain my risk level");

    expect(mockPrisma.client.user.findUnique).toHaveBeenCalledWith({ where: { id: "user-1" } });
    expect(result.matchedIntent).toBe("RISK");
    expect(result.answer).toContain("aggressive");
    expect(result.answer).toContain("concentrated"); // 75% > 60% threshold
  });
});
