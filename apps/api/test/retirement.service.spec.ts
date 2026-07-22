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
  });
});
