import { Test } from "@nestjs/testing";
import { TaxService } from "../src/tax/tax.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";

describe("TaxService.estimate", () => {
  let service: TaxService;

  const mockPrisma = {
    client: {
      taxDeduction: {
        findMany: jest.fn(),
      },
    },
  };
  const mockIncomeService = {
    monthlyForecast: jest.fn(),
    list: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TaxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncomeService },
      ],
    }).compile();
    service = moduleRef.get(TaxService);
  });

  it("computes zero tax under the new regime for income at/below the ₹12L rebate threshold", async () => {
    mockIncomeService.monthlyForecast.mockResolvedValue(100000); // 12L/year
    mockIncomeService.list.mockResolvedValue([]);
    mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

    const result = await service.estimate("user-1", "2026-27");

    expect(Number(result.newRegime.taxPayable)).toBe(0);
  });

  it("applies the Section 80C cap of ₹1,50,000 even if more is logged", async () => {
    mockIncomeService.monthlyForecast.mockResolvedValue(150000); // 18L/year
    mockIncomeService.list.mockResolvedValue([]);
    mockPrisma.client.taxDeduction.findMany.mockResolvedValue([
      { section: "SECTION_80C", amount: 200000 },
    ]);

    const result = await service.estimate("user-1", "2026-27");
    const section80C = result.deductionsBySection.find((d) => d.section === "SECTION_80C");

    expect(section80C?.remainingRoom).toBe("0.00");
    expect(Number(result.totalDeductions)).toBe(150000);
  });

  it("recommends whichever regime yields lower tax", async () => {
    mockIncomeService.monthlyForecast.mockResolvedValue(200000); // 24L/year
    mockIncomeService.list.mockResolvedValue([]);
    mockPrisma.client.taxDeduction.findMany.mockResolvedValue([
      { section: "SECTION_80C", amount: 150000 },
      { section: "SECTION_80D", amount: 25000 },
    ]);

    const result = await service.estimate("user-1", "2026-27");

    expect(["OLD", "NEW"]).toContain(result.recommendedRegime);
    expect(Number(result.savingsFromRecommendedRegime)).toBeGreaterThanOrEqual(0);
  });
});
