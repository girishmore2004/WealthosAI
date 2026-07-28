import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { GoalsService } from "../src/goals/goals.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("GoalsService.list (feasibility enrichment)", () => {
  let service: GoalsService;
  const mockPrisma = {
    client: { goal: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() } },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [GoalsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(GoalsService);
  });

  function futureDate(monthsFromNow: number): Date {
    const d = new Date();
    d.setMonth(d.getMonth() + monthsFromNow);
    return d;
  }

  it("marks a goal ON_TRACK when the current contribution already meets or exceeds what's required", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([
      {
        id: "g1", name: "Emergency fund", targetAmount: 120000, currentAmount: 0,
        monthlyContribution: 15000, targetDate: futureDate(12), investments: [],
      },
    ]);

    const [goal] = await service.list("user-1");

    expect(goal.probabilityOfSuccess).toBe("ON_TRACK");
    expect(goal.requiredMonthlyContribution).toBeCloseTo(10000, -2);
    // New fields, defaulted: no assumedAnnualReturnPercent set on this goal.
    expect(goal.isPaceHeuristic).toBe(true);
    expect(goal.assumedAnnualReturnPercent).toBe("0.00");
    expect(goal.projectedInvestmentValueAtTarget).toBe("0.00"); // no linked investments
  });

  it("marks a goal OFF_TRACK when the contribution is far below what's required", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([
      {
        id: "g1", name: "House down payment", targetAmount: 2000000, currentAmount: 0,
        monthlyContribution: 5000, targetDate: futureDate(12), investments: [],
      },
    ]);

    const [goal] = await service.list("user-1");

    expect(goal.probabilityOfSuccess).toBe("OFF_TRACK");
  });

  it("counts linked investment value toward progress, not just currentAmount", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([
      {
        id: "g1", name: "Retirement top-up", targetAmount: 100000, currentAmount: 20000,
        monthlyContribution: 0, targetDate: futureDate(6),
        investments: [{ currentValue: 30000 }, { currentValue: 10000 }],
      },
    ]);

    const [goal] = await service.list("user-1");

    expect(Number(goal.linkedInvestmentValue)).toBe(40000);
    expect(goal.progressPercent).toBe(60);
  });

  it("treats an already-passed target date as zero months remaining without crashing", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([
      {
        id: "g1", name: "Overdue goal", targetAmount: 50000, currentAmount: 0,
        monthlyContribution: 1000, targetDate: futureDate(-3), investments: [],
      },
    ]);

    const [goal] = await service.list("user-1");

    expect(Number.isFinite(goal.requiredMonthlyContribution)).toBe(true);
    expect(goal.probabilityOfSuccess).toBe("OFF_TRACK");
  });

  it("caps progressPercent at 100 even if saved amount exceeds the target", async () => {
    mockPrisma.client.goal.findMany.mockResolvedValue([
      {
        id: "g1", name: "Overfunded goal", targetAmount: 50000, currentAmount: 80000,
        monthlyContribution: 0, targetDate: futureDate(6), investments: [],
      },
    ]);

    const [goal] = await service.list("user-1");

    expect(goal.progressPercent).toBeLessThanOrEqual(100);
  });

  describe("growth-aware feasibility projection (new)", () => {
    it("reduces requiredMonthlyContribution when assumedAnnualReturnPercent is set, versus the flat (0%) default", async () => {
      const base = {
        id: "g1", name: "Growth goal", targetAmount: 400000, currentAmount: 0,
        monthlyContribution: 7000, targetDate: futureDate(24),
        investments: [{ currentValue: 200000 }],
      };

      mockPrisma.client.goal.findMany.mockResolvedValue([base]);
      const [flatGoal] = await service.list("user-1");

      mockPrisma.client.goal.findMany.mockResolvedValue([{ ...base, assumedAnnualReturnPercent: 12 }]);
      const [growthGoal] = await service.list("user-1");

      expect(growthGoal.requiredMonthlyContribution).toBeLessThan(flatGoal.requiredMonthlyContribution);
      expect(Number(growthGoal.projectedInvestmentValueAtTarget)).toBeGreaterThan(200000);
      // This specific scenario is chosen so the reduced requirement actually flips the
      // pace bucket — a concrete demonstration that ignoring investment growth
      // (the original behavior) could understate a goal's real feasibility.
      expect(flatGoal.probabilityOfSuccess).toBe("AT_RISK");
      expect(growthGoal.probabilityOfSuccess).toBe("ON_TRACK");
    });

    it("does not apply growth to progressPercent or linkedInvestmentValue — only to the forward-looking figures", async () => {
      mockPrisma.client.goal.findMany.mockResolvedValue([
        {
          id: "g1", name: "Growth goal", targetAmount: 400000, currentAmount: 0,
          monthlyContribution: 0, targetDate: futureDate(24),
          investments: [{ currentValue: 200000 }], assumedAnnualReturnPercent: 12,
        },
      ]);

      const [goal] = await service.list("user-1");

      // Today's actual state — unaffected by the growth assumption.
      expect(Number(goal.linkedInvestmentValue)).toBe(200000);
      expect(goal.progressPercent).toBe(50); // 200000/400000, no growth applied here
    });
  });

  describe("contributionPaceRatio / isPaceHeuristic (new)", () => {
    it("computes a real ratio, not a bucketed label", async () => {
      mockPrisma.client.goal.findMany.mockResolvedValue([
        {
          id: "g1", name: "Ratio goal", targetAmount: 120000, currentAmount: 0,
          monthlyContribution: 5000, targetDate: futureDate(12), investments: [],
        },
      ]);

      const [goal] = await service.list("user-1");

      // required ≈ 10000/mo, contributing 5000/mo -> ratio ≈ 0.5
      expect(goal.contributionPaceRatio).toBeCloseTo(0.5, 1);
      expect(goal.isPaceHeuristic).toBe(true);
    });

    it("reports a ratio of 1 when no further contribution is actually required", async () => {
      mockPrisma.client.goal.findMany.mockResolvedValue([
        {
          id: "g1", name: "Already funded", targetAmount: 50000, currentAmount: 80000,
          monthlyContribution: 0, targetDate: futureDate(6), investments: [],
        },
      ]);

      const [goal] = await service.list("user-1");

      expect(goal.contributionPaceRatio).toBe(1);
    });
  });
});

describe("GoalsService update/remove (atomic ownership hardening)", () => {
  let service: GoalsService;
  const mockPrisma = {
    client: { goal: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() } },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [GoalsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(GoalsService);
  });

  describe("update", () => {
    it("updates and returns the enriched row when it exists and is owned by the caller", async () => {
      mockPrisma.client.goal.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.goal.findUnique.mockResolvedValue({
        id: "g1", name: "Renamed goal", targetAmount: 100000, currentAmount: 0,
        monthlyContribution: 5000, targetDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
        investments: [],
      });

      const result = await service.update("user-1", "g1", { name: "Renamed goal" } as any);

      expect(mockPrisma.client.goal.updateMany).toHaveBeenCalledWith({
        where: { id: "g1", userId: "user-1" },
        data: { name: "Renamed goal", targetDate: undefined },
      });
      expect(result.name).toBe("Renamed goal");
    });

    it("throws NotFoundException without leaking whether the id exists for another user", async () => {
      mockPrisma.client.goal.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update("user-1", "not-mine", {} as any)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.client.goal.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes atomically scoped by owner and returns the id", async () => {
      mockPrisma.client.goal.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.remove("user-1", "g1");

      expect(mockPrisma.client.goal.deleteMany).toHaveBeenCalledWith({ where: { id: "g1", userId: "user-1" } });
      expect(result).toEqual({ id: "g1" });
    });

    it("throws NotFoundException when the id doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.goal.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.remove("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });
});
