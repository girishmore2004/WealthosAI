import { Test } from "@nestjs/testing";
import { InsuranceService } from "../src/insurance/insurance.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";

describe("InsuranceService.gapAnalysis", () => {
  let service: InsuranceService;
  const mockPrisma = {
    client: {
      insurancePolicy: { findMany: jest.fn() },
      user: { findUnique: jest.fn() },
    },
  };
  const mockIncome = { monthlyForecast: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.user.findUnique.mockResolvedValue({ household: { dependents: [] } });
    const moduleRef = await Test.createTestingModule({
      providers: [
        InsuranceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncome },
      ],
    }).compile();
    service = moduleRef.get(InsuranceService);
  });

  it("flags a complete absence of term coverage as a significant gap (10x income benchmark)", async () => {
    mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
    mockIncome.monthlyForecast.mockResolvedValue(100000); // 12L/year

    const gaps = await service.gapAnalysis("user-1");
    const term = gaps.find((g) => g.type === "TERM")!;

    expect(term.hasCoverage).toBe(false);
    expect(Number(term.recommendedCoverage)).toBeCloseTo(12000000, 0); // 10x annual income
    expect(term.message).toMatch(/no term life policy found/i);
  });

  it("marks coverage adequate (zero gap) when it meets or exceeds the benchmark", async () => {
    mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([{ type: "TERM", coverageAmount: 15000000 }]);
    mockIncome.monthlyForecast.mockResolvedValue(100000);

    const gaps = await service.gapAnalysis("user-1");
    const term = gaps.find((g) => g.type === "TERM")!;

    expect(term.hasCoverage).toBe(true);
    expect(term.gap).toBe("0.00");
  });

  it("increases the recommended health coverage benchmark per dependent", async () => {
    mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
    mockIncome.monthlyForecast.mockResolvedValue(50000);
    mockPrisma.client.user.findUnique.mockResolvedValue({ household: { dependents: [{}, {}] } }); // 2 dependents

    const gaps = await service.gapAnalysis("user-1");
    const health = gaps.find((g) => g.type === "HEALTH")!;

    // base 500000 + 2 * 300000 = 1100000
    expect(Number(health.recommendedCoverage)).toBeCloseTo(1100000, 0);
  });

  it("sums coverage across multiple policies of the same type before comparing to the benchmark", async () => {
    mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([
      { type: "HEALTH", coverageAmount: 300000 },
      { type: "HEALTH", coverageAmount: 300000 },
    ]);
    mockIncome.monthlyForecast.mockResolvedValue(50000);

    const gaps = await service.gapAnalysis("user-1");
    const health = gaps.find((g) => g.type === "HEALTH")!;

    expect(Number(health.currentCoverage)).toBe(600000);
  });
});
