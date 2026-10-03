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
import { RagAutoReindexService } from "../src/ai/ops/rag-auto-reindex.service";
import { FinancialFactsService } from "../src/common/financial-facts/financial-facts.service";

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
  // NEW (audit item #7)
  const mockRagAutoReindex = { triggerFor: jest.fn().mockResolvedValue(undefined) };
  const mockFacts = { getFinancialPosition: jest.fn(), getMonthlyCashFlow: jest.fn() };

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
        { provide: RagAutoReindexService, useValue: mockRagAutoReindex },
        { provide: FinancialFactsService, useValue: mockFacts },
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

  describe("RAG auto-reindex trigger (new, audit item #7)", () => {
    it("triggers a reindex after a successfully-matched interaction", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", riskProfile: "AGGRESSIVE" });
      mockInvestments.summary.mockResolvedValue({ allocation: [] });
      mockLoans.debtSummary.mockResolvedValue({ debtStressScore: 5 });

      await service.ask("user-1", "explain my risk level");

      expect(mockRagAutoReindex.triggerFor).toHaveBeenCalledWith("user-1");
    });

    it("still triggers a reindex even for a refused (unmatched) question", async () => {
      await service.ask("user-1", "what is the meaning of life");

      // A refused interaction is still a real, newly-created CoachInteraction row —
      // the trigger doesn't distinguish, matching the roadmap's plain
      // "post-interaction" instruction.
      expect(mockRagAutoReindex.triggerFor).toHaveBeenCalledWith("user-1");
    });
  });

  describe("authoritative net worth and savings rate", () => {
    const position = {
      netWorth: "4750000.00", totalAssets: "4955000.00", totalLiabilities: "205000.00",
      cash: { available: "33000.00", emergency: "7000.00", total: "40000.00" },
      investmentValue: "200000.00", property: "4500000.00", dataHealth: [],
    };

    it("answers net worth from FinancialFactsService (includes property and the emergency reserve), not from raw lists", async () => {
      mockFacts.getFinancialPosition.mockResolvedValue(position);

      const result = await service.ask("user-1", "what is my net worth");

      expect(result.answer).toContain("₹47,50,000");
      expect(result.answer).toContain("₹7,000"); // emergency cash is shown
      expect(mockIncome.list).not.toHaveBeenCalled();
      expect(mockExpenses.list).not.toHaveBeenCalled();
    });

    it("mentions when records are flagged for review", async () => {
      mockFacts.getFinancialPosition.mockResolvedValue({ ...position, dataHealth: [{ code: "INVESTMENT_AS_EXPENSE", severity: "WARNING", message: "m", count: 1 }] });

      const result = await service.ask("user-1", "what is my net worth");

      expect(result.answer).toMatch(/flagged for review/);
    });

    it("answers savings rate once as a percentage (76.9%, never 7692%) and keeps SIPs out of spending", async () => {
      mockFacts.getMonthlyCashFlow.mockResolvedValue({
        income: "65000.00", expenses: "15000.00", investmentContributions: "10000.00", savingsRate: "0.769230769230769",
      });

      const result = await service.ask("user-1", "what is my savings rate");

      expect(result.answer).toContain("76.9%");
      expect(result.answer).not.toMatch(/7692|7,692/);
      expect(result.answer).toContain("₹10,000");
    });

    it("says it cannot compute the savings rate when no income was received this month", async () => {
      mockFacts.getMonthlyCashFlow.mockResolvedValue({ income: "0.00", expenses: "100.00", investmentContributions: "0.00", savingsRate: null });

      const result = await service.ask("user-1", "what is my savings rate");

      expect(result.answer).toMatch(/can't compute a savings rate/);
    });
  });
});
