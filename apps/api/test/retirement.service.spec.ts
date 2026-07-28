import { Test } from "@nestjs/testing";
import { RetirementService } from "../src/retirement/retirement.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("RetirementService.computePlan", () => {
  let service: RetirementService;

  const mockPrisma = {
    client: {
      retirementProfile: { findUnique: jest.fn(), create: jest.fn() },
      user: { findUnique: jest.fn() },
      investment: { findMany: jest.fn() },
      goal: { findMany: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [RetirementService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(RetirementService);
  });

  it("reports onTrack=true when projected current corpus already covers the target", async () => {
    mockPrisma.client.retirementProfile.findUnique.mockResolvedValue({
      userId: "user-1",
      targetRetirementAge: 60,
      desiredMonthlyIncomeToday: 50000,
      inflationRatePercent: 6,
      expectedReturnPreRetirementPercent: 11,
      expectedReturnPostRetirementPercent: 7,
    });
    mockPrisma.client.user.findUnique.mockResolvedValue({
      dateOfBirth: new Date(new Date().getFullYear() - 58, 0, 1), // age 58, close to retirement
    });
    mockPrisma.client.investment.findMany.mockResolvedValue([
      { type: "EPF", currentValue: 20000000 }, // very large corpus already saved
    ]);
    mockPrisma.client.goal.findMany.mockResolvedValue([]);

    const plan = await service.computePlan("user-1");

    expect(plan.onTrack).toBe(true);
    expect(Number(plan.corpusGap)).toBe(0);
    // New fields, defaulted: no lifeExpectancyAge/pension set on this profile.
    expect(plan.drawdownHorizonYears).toBe(25);
    expect(plan.isHorizonFromLifeExpectancy).toBe(false);
    expect(plan.monthlyPensionOffset).toBe("0.00");
    expect(plan.netMonthlyIncomeNeededFromCorpus).toBe(plan.monthlyIncomeAtRetirement);
  });

  it("computes a positive required SIP when there's a corpus gap", async () => {
    mockPrisma.client.retirementProfile.findUnique.mockResolvedValue({
      userId: "user-1",
      targetRetirementAge: 60,
      desiredMonthlyIncomeToday: 80000,
      inflationRatePercent: 6,
      expectedReturnPreRetirementPercent: 11,
      expectedReturnPostRetirementPercent: 7,
    });
    mockPrisma.client.user.findUnique.mockResolvedValue({
      dateOfBirth: new Date(new Date().getFullYear() - 30, 0, 1), // age 30
    });
    mockPrisma.client.investment.findMany.mockResolvedValue([]);
    mockPrisma.client.goal.findMany.mockResolvedValue([]);

    const plan = await service.computePlan("user-1");

    expect(plan.onTrack).toBe(false);
    expect(Number(plan.requiredMonthlySip)).toBeGreaterThan(0);
    expect(plan.yearsToRetirement).toBe(30);
    expect(plan.drawdownHorizonYears).toBe(25); // still the default — unaffected
  });

  describe("life-expectancy-aware drawdown horizon (new)", () => {
    const baseProfile = {
      userId: "user-1",
      targetRetirementAge: 60,
      desiredMonthlyIncomeToday: 80000,
      inflationRatePercent: 6,
      expectedReturnPreRetirementPercent: 11,
      expectedReturnPostRetirementPercent: 7,
    };
    const age30 = { dateOfBirth: new Date(new Date().getFullYear() - 30, 0, 1) };

    it("derives a shorter horizon from lifeExpectancyAge, producing a smaller corpus requirement than the 25-year default", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(age30);
      mockPrisma.client.investment.findMany.mockResolvedValue([]);
      mockPrisma.client.goal.findMany.mockResolvedValue([]);

      mockPrisma.client.retirementProfile.findUnique.mockResolvedValue(baseProfile); // no lifeExpectancyAge
      const defaultPlan = await service.computePlan("user-1");

      mockPrisma.client.retirementProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        lifeExpectancyAge: 75, // retiring at 60, horizon = 15 years, much shorter than the 25-year default
      });
      const shorterHorizonPlan = await service.computePlan("user-1");

      expect(shorterHorizonPlan.drawdownHorizonYears).toBe(15);
      expect(shorterHorizonPlan.isHorizonFromLifeExpectancy).toBe(true);
      expect(Number(shorterHorizonPlan.corpusRequired)).toBeLessThan(Number(defaultPlan.corpusRequired));
    });

    it("falls back to the 25-year default when lifeExpectancyAge is not actually later than targetRetirementAge", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(age30);
      mockPrisma.client.investment.findMany.mockResolvedValue([]);
      mockPrisma.client.goal.findMany.mockResolvedValue([]);
      mockPrisma.client.retirementProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        lifeExpectancyAge: 55, // earlier than targetRetirementAge (60) — not meaningful
      });

      const plan = await service.computePlan("user-1");

      expect(plan.drawdownHorizonYears).toBe(25);
      expect(plan.isHorizonFromLifeExpectancy).toBe(false);
    });
  });

  describe("pension/annuity income offset (new)", () => {
    const baseProfile = {
      userId: "user-1",
      targetRetirementAge: 60,
      desiredMonthlyIncomeToday: 80000,
      inflationRatePercent: 6,
      expectedReturnPreRetirementPercent: 11,
      expectedReturnPostRetirementPercent: 7,
    };
    const age30 = { dateOfBirth: new Date(new Date().getFullYear() - 30, 0, 1) };

    it("reduces corpusRequired when a partial pension is expected", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(age30);
      mockPrisma.client.investment.findMany.mockResolvedValue([]);
      mockPrisma.client.goal.findMany.mockResolvedValue([]);

      mockPrisma.client.retirementProfile.findUnique.mockResolvedValue(baseProfile);
      const noPensionPlan = await service.computePlan("user-1");

      const monthlyIncomeAtRetirement = Number(noPensionPlan.monthlyIncomeAtRetirement);
      const partialPension = monthlyIncomeAtRetirement * 0.3; // covers 30% of the target income

      mockPrisma.client.retirementProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        expectedMonthlyPensionAtRetirement: partialPension,
      });
      const withPensionPlan = await service.computePlan("user-1");

      expect(Number(withPensionPlan.monthlyPensionOffset)).toBeCloseTo(partialPension, 2);
      expect(Number(withPensionPlan.netMonthlyIncomeNeededFromCorpus)).toBeCloseTo(
        monthlyIncomeAtRetirement - partialPension,
        2,
      );
      expect(Number(withPensionPlan.corpusRequired)).toBeLessThan(Number(noPensionPlan.corpusRequired));
    });

    it("floors netMonthlyIncomeNeededFromCorpus and corpusRequired at zero when the pension exceeds the target income", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(age30);
      mockPrisma.client.investment.findMany.mockResolvedValue([]);
      mockPrisma.client.goal.findMany.mockResolvedValue([]);
      mockPrisma.client.retirementProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        desiredMonthlyIncomeToday: 20000,
        expectedMonthlyPensionAtRetirement: 999999999, // deliberately far larger than any realistic target income
      });

      const plan = await service.computePlan("user-1");

      expect(plan.netMonthlyIncomeNeededFromCorpus).toBe("0.00");
      expect(plan.corpusRequired).toBe("0.00");
      // The offset itself is still reported honestly capped at what was actually needed,
      // not the full (much larger) pension figure the user entered.
      expect(Number(plan.monthlyPensionOffset)).toBeCloseTo(Number(plan.monthlyIncomeAtRetirement), 2);
    });
  });
});
