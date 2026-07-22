import { Test } from "@nestjs/testing";
import { GoalsService } from "../src/goals/goals.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("GoalsService.list (feasibility enrichment)", () => {
  let service: GoalsService;
  const mockPrisma = { client: { goal: { findMany: jest.fn() } } };

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
});
