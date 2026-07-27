import { Test } from "@nestjs/testing";
import { TaxService, applySlabs, findSurchargeRate } from "../src/tax/tax.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";
import { TAX_CONFIG_BY_YEAR, resolveTaxYearConfig } from "../src/tax/tax-slab-config";

describe("tax-slab-config: resolveTaxYearConfig", () => {
  it("returns an exact match with isEstimatedFromPriorYear=false when the year is configured", () => {
    const { config, isEstimatedFromPriorYear } = resolveTaxYearConfig("2025-26");
    expect(config.financialYear).toBe("2025-26");
    expect(isEstimatedFromPriorYear).toBe(false);
  });

  it("falls back to the latest available year with isEstimatedFromPriorYear=true for an unconfigured year", () => {
    const { config, isEstimatedFromPriorYear } = resolveTaxYearConfig("2030-31");
    expect(config.financialYear).toBe("2025-26"); // the only/latest entry today
    expect(isEstimatedFromPriorYear).toBe(true);
  });
});

describe("tax.service pure functions: applySlabs / findSurchargeRate", () => {
  const oldSlabs = TAX_CONFIG_BY_YEAR["2025-26"].oldRegimeSlabs;
  const oldSurcharge = TAX_CONFIG_BY_YEAR["2025-26"].oldRegimeSurchargeSlabs;
  const newSurcharge = TAX_CONFIG_BY_YEAR["2025-26"].newRegimeSurchargeSlabs;

  it("computes marginal slab tax correctly at a known income level", () => {
    // 0-2.5L: 0, 2.5-5L: 12500, 5-10L: 100000 -> 112500 total on exactly ₹10,00,000
    expect(applySlabs(1000000, oldSlabs)).toBeCloseTo(112500, 2);
  });

  it("returns 0 surcharge below the ₹50L threshold", () => {
    expect(findSurchargeRate(4999999, oldSurcharge)).toBe(0);
    expect(findSurchargeRate(5000000, oldSurcharge)).toBe(0); // boundary is exclusive
  });

  it("returns 10% surcharge just above ₹50L, 15% above ₹1cr", () => {
    expect(findSurchargeRate(5000001, oldSurcharge)).toBe(0.1);
    expect(findSurchargeRate(10000000, oldSurcharge)).toBe(0.1); // boundary is inclusive on the upper end
    expect(findSurchargeRate(10000001, oldSurcharge)).toBe(0.15);
  });

  it("old regime reaches 37% above ₹5cr; new regime caps at 25% and never reaches 37%", () => {
    expect(findSurchargeRate(60000000, oldSurcharge)).toBe(0.37);
    expect(findSurchargeRate(60000000, newSurcharge)).toBe(0.25); // capped, no 37% bracket exists
    expect(findSurchargeRate(25000000, newSurcharge)).toBe(0.25); // already capped above ₹2cr
  });
});

describe("TaxService.estimate", () => {
  let service: TaxService;

  const mockPrisma = { client: { taxDeduction: { findMany: jest.fn() } } };
  const mockIncomeService = { monthlyForecast: jest.fn(), list: jest.fn() };

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
    expect(Number(result.newRegime.surcharge)).toBe(0);
  });

  it("applies the Section 80C cap of ₹1,50,000 even if more is logged", async () => {
    mockIncomeService.monthlyForecast.mockResolvedValue(150000); // 18L/year
    mockIncomeService.list.mockResolvedValue([]);
    mockPrisma.client.taxDeduction.findMany.mockResolvedValue([{ section: "SECTION_80C", amount: 200000 }]);

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

  describe("versioned slab config (new)", () => {
    it("uses the exact FY2025-26 config directly, with slabsAreEstimated=false", async () => {
      mockIncomeService.monthlyForecast.mockResolvedValue(100000);
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2025-26");

      expect(result.slabsFinancialYear).toBe("2025-26");
      expect(result.slabsAreEstimated).toBe(false);
      expect(result.financialYear).toBe("2025-26"); // the requested year, unchanged meaning
    });

    it("falls back to the latest configured year and flags slabsAreEstimated=true for a future, unconfigured FY", async () => {
      mockIncomeService.monthlyForecast.mockResolvedValue(100000);
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2031-32");

      expect(result.financialYear).toBe("2031-32"); // still reflects what was actually requested
      expect(result.slabsFinancialYear).toBe("2025-26"); // but the slabs used are the latest known
      expect(result.slabsAreEstimated).toBe(true);
    });
  });

  describe("surcharge (new)", () => {
    it("computes zero surcharge for income well below ₹50L", async () => {
      mockIncomeService.monthlyForecast.mockResolvedValue(200000); // 24L/year, same as the pre-existing test above
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2025-26");

      expect(Number(result.oldRegime.surcharge)).toBe(0);
      expect(Number(result.newRegime.surcharge)).toBe(0);
    });

    it("applies a 10% surcharge on old-regime tax for taxable income just above ₹50L", async () => {
      // Gross 84L/year (₹7,00,000/month — chosen to divide evenly, avoiding any
      // floating-point rounding noise in the hand-verified expected values below),
      // old-regime taxable = 84L - 50k standard deduction = 83.5L (> ₹50L threshold).
      mockIncomeService.monthlyForecast.mockResolvedValue(700000);
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2025-26");

      // base tax on 8350000 = 12500 + 100000 + (8350000-1000000)*0.3 = 2317500
      // surcharge at 10% = 231750; taxPayable = (2317500+231750)*1.04 = 2651220
      expect(Number(result.oldRegime.surcharge)).toBeCloseTo(231750, 1);
      expect(Number(result.oldRegime.taxPayable)).toBeCloseTo(2651220, 1);
    });
  });
});
