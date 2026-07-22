import { Test } from "@nestjs/testing";
import { SimulatorService } from "../src/simulator/simulator.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { InvestmentsService } from "../src/investments/investments.service";
import { LoansService } from "../src/loans/loans.service";
import { RetirementService } from "../src/retirement/retirement.service";
import { GoalsService } from "../src/goals/goals.service";

describe("SimulatorService", () => {
  let service: SimulatorService;

  const mockPrisma = {
    client: {
      user: { findUnique: jest.fn() },
      savedScenario: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    },
  };
  const mockIncome = { monthlyForecast: jest.fn(), list: jest.fn() };
  const mockExpenses = { list: jest.fn() };
  const mockInvestments = { totalCurrentValue: jest.fn() };
  const mockLoans = { totalOutstanding: jest.fn(), prepaymentImpact: jest.fn() };
  const mockRetirement = { getOrCreateProfile: jest.fn(), computePlan: jest.fn() };
  const mockGoals = { list: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockIncome.monthlyForecast.mockResolvedValue(100000);
    mockIncome.list.mockResolvedValue([{ amount: 100000 }]);
    mockExpenses.list.mockResolvedValue([{ amount: 60000 }]);
    mockInvestments.totalCurrentValue.mockResolvedValue(300000);
    mockLoans.totalOutstanding.mockResolvedValue(200000);
    mockPrisma.client.user.findUnique.mockResolvedValue({ dateOfBirth: new Date(1994, 0, 1) });
    mockRetirement.getOrCreateProfile.mockResolvedValue({ targetRetirementAge: 60 });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SimulatorService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncome },
        { provide: ExpensesService, useValue: mockExpenses },
        { provide: InvestmentsService, useValue: mockInvestments },
        { provide: LoansService, useValue: mockLoans },
        { provide: RetirementService, useValue: mockRetirement },
        { provide: GoalsService, useValue: mockGoals },
      ],
    }).compile();
    service = moduleRef.get(SimulatorService);
  });

  describe("run — validation", () => {
    it("rejects a scenario with a missing required field before touching the engine", async () => {
      await expect(service.run("user-1", "SALARY_HIKE", {})).rejects.toThrow(/percentIncrease/);
    });

    it("rejects a non-numeric value for a numeric field", async () => {
      await expect(service.run("user-1", "SALARY_HIKE", { percentIncrease: "ten" })).rejects.toThrow(/must be a number/);
    });

    it("accepts string ids for loanId/goalId without requiring them to be numbers", async () => {
      mockLoans.prepaymentImpact.mockResolvedValue({ interestSaved: 1000, monthsSaved: 2, newTenureMonths: 10 });
      const { result } = await service.run("user-1", "LOAN_PREPAYMENT", { loanId: "loan-abc", lumpSum: 50000 });
      expect(result.scenarioType).toBe("LOAN_PREPAYMENT");
    });
  });

  describe("run — DB-backed baseline", () => {
    it("builds the baseline from real service data, scoped to the requesting user", async () => {
      await service.run("user-42", "SALARY_HIKE", { percentIncrease: 10 });

      expect(mockIncome.monthlyForecast).toHaveBeenCalledWith("user-42");
      expect(mockInvestments.totalCurrentValue).toHaveBeenCalledWith("user-42");
      expect(mockLoans.totalOutstanding).toHaveBeenCalledWith("user-42");
    });

    it("does not write anything to the DB for a plain run (only save() should persist)", async () => {
      await service.run("user-1", "SALARY_HIKE", { percentIncrease: 10 });
      expect(mockPrisma.client.savedScenario.create).not.toHaveBeenCalled();
    });
  });

  describe("save / listSaved / removeSaved — real persistence", () => {
    it("persists params and the computed result snapshot together", async () => {
      mockPrisma.client.savedScenario.create.mockResolvedValue({
        id: "s1", scenarioType: "SALARY_HIKE", label: "10% raise", params: { percentIncrease: 10 },
        resultSnapshot: { scenarioType: "SALARY_HIKE" }, createdAt: new Date(),
      });

      const saved = await service.save("user-1", "SALARY_HIKE", { percentIncrease: 10 }, "10% raise");

      expect(mockPrisma.client.savedScenario.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: "user-1", scenarioType: "SALARY_HIKE", label: "10% raise" }),
        }),
      );
      expect(saved.id).toBe("s1");
    });

    it("lists only the requesting user's saved scenarios, most recent first", async () => {
      mockPrisma.client.savedScenario.findMany.mockResolvedValue([]);
      await service.listSaved("user-1");
      expect(mockPrisma.client.savedScenario.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" }, orderBy: { createdAt: "desc" } }),
      );
    });

    it("rejects deleting a scenario owned by a different user", async () => {
      mockPrisma.client.savedScenario.findUnique.mockResolvedValue({ id: "s1", userId: "someone-else" });
      await expect(service.removeSaved("user-1", "s1")).rejects.toThrow();
      expect(mockPrisma.client.savedScenario.delete).not.toHaveBeenCalled();
    });

    it("throws NotFound when deleting a scenario that doesn't exist", async () => {
      mockPrisma.client.savedScenario.findUnique.mockResolvedValue(null);
      await expect(service.removeSaved("user-1", "missing")).rejects.toThrow();
    });
  });

  describe("compare", () => {
    it("only returns saved scenarios owned by the requesting user, even if other ids are requested", async () => {
      mockPrisma.client.savedScenario.findMany.mockResolvedValue([
        { id: "s1", scenarioType: "SALARY_HIKE", label: "A", params: {}, resultSnapshot: {}, createdAt: new Date() },
      ]);

      const result = await service.compare("user-1", ["s1", "s2-not-mine"]);

      expect(mockPrisma.client.savedScenario.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ["s1", "s2-not-mine"] }, userId: "user-1" } }),
      );
      expect(result).toHaveLength(1);
    });
  });
});
