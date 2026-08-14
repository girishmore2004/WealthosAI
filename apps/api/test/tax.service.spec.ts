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

  // Was `{ taxDeduction: { findMany } }` only — estimate() now also calls
  // capitalGainsSummary() internally (audit item #11), which queries
  // realizedGainEvent.findMany(). Defaulted to "no realized gains" in beforeEach below
  // so every pre-existing test in this block (none of which mention capital gains)
  // keeps computing byte-identical income-tax figures, with capitalGains coming back
  // all-zero.
  const mockPrisma = { client: { taxDeduction: { findMany: jest.fn() }, realizedGainEvent: { findMany: jest.fn() } } };
  const mockIncomeService = { monthlyForecast: jest.fn(), list: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.realizedGainEvent.findMany.mockResolvedValue([]);
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
      // Taxable income here (₹83.5L) is far enough past the ₹50L threshold
      // (₹33.5L past it) that marginal relief does NOT apply — see the dedicated
      // "marginal relief" block below for the case where it does.
      expect(Number(result.oldRegime.surcharge)).toBeCloseTo(231750, 1);
      expect(Number(result.oldRegime.taxPayable)).toBeCloseTo(2651220, 1);
      expect(result.oldRegime.marginalReliefApplied).toBe(false);
    });
  });

  describe("marginal relief (new, audit item #14)", () => {
    it("caps the surcharge so total tax just past the ₹50L threshold never exceeds tax-at-threshold + the excess income", async () => {
      // Old-regime taxable income exactly ₹100 over the ₹50L threshold.
      // Gross income chosen so taxable (after ₹50k standard deduction) lands at
      // exactly 5000100: gross = 5000100 + 50000 = 5050100/year -> /12 per month.
      mockIncomeService.monthlyForecast.mockResolvedValue(5050100 / 12);
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2025-26");

      // Hand-verified (see applyMarginalRelief()'s own doc comment for the formula):
      // baseTax(5000100)  = 12500 + 100000 + (5000100-1000000)*0.3 = 1312530
      // baseTax(5000000)  = 1312500 (tax exactly at the threshold, 0% surcharge there)
      // maxAllowedTotal   = 1312500 + (5000100-5000000) = 1312600
      // reliefed surcharge = maxAllowedTotal - baseTax(5000100) = 1312600-1312530 = 70
      // — versus an unrelieved 10% surcharge of 131,253, a huge difference for just
      // ₹100 of extra income.
      expect(Number(result.oldRegime.taxableIncome)).toBeCloseTo(5000100, 0);
      expect(Number(result.oldRegime.surcharge)).toBeCloseTo(70, 1);
      expect(result.oldRegime.marginalReliefApplied).toBe(true);
    });

    it("applies no surcharge and no relief exactly at the threshold itself", async () => {
      // Taxable income exactly ₹50,00,000 — the boundary is exclusive (from the
      // existing findSurchargeRate boundary tests), so surcharge is genuinely 0 here,
      // not a relief-adjusted near-zero value.
      mockIncomeService.monthlyForecast.mockResolvedValue(5050000 / 12); // taxable = 5000000 after 50k deduction
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2025-26");

      expect(Number(result.oldRegime.taxableIncome)).toBeCloseTo(5000000, 0);
      expect(Number(result.oldRegime.surcharge)).toBe(0);
      expect(result.oldRegime.marginalReliefApplied).toBe(false);
    });

    it("caps the surcharge just above the ₹1cr threshold too (relief applies at every threshold, not just the first)", async () => {
      // Taxable income exactly ₹100 over ₹1,00,00,000.
      mockIncomeService.monthlyForecast.mockResolvedValue((10000100 + 50000) / 12);
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2025-26");

      // baseTax(10000100) = 12500+100000+(10000100-1000000)*0.3 = 2812530
      // baseTax(10000000) = 2812500; rate AT the ₹1cr threshold itself is the
      // PREVIOUS bracket's rate (10%, from the ₹50L-₹1cr bracket), not 0 — since
      // ₹1,00,00,000 falls in the "from:5000000,to:10000000,rate:0.1" bracket per
      // findSurchargeBracket's `income > from && income <= to` semantics.
      // totalAtThreshold = 2812500 * 1.10 = 3093750
      // maxAllowedTotal = 3093750 + 100 = 3093850
      // unrelieved (15%) surcharge would be 2812530*0.15 = 421879.5 — far larger than
      // the relieved amount below.
      const reliefedSurcharge = 3093850 - 2812530; // = 281320
      expect(Number(result.oldRegime.surcharge)).toBeCloseTo(reliefedSurcharge, 0);
      expect(result.oldRegime.marginalReliefApplied).toBe(true);
    });

    it("applies marginal relief on the new regime too, using its own (25%-capped) surcharge table", async () => {
      // New-regime taxable income exactly ₹100 over ₹50L (standard deduction 75k, so
      // gross = 5000100 + 75000).
      mockIncomeService.monthlyForecast.mockResolvedValue((5000100 + 75000) / 12);
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2025-26");

      expect(Number(result.newRegime.taxableIncome)).toBeCloseTo(5000100, 0);
      expect(result.newRegime.marginalReliefApplied).toBe(true);
      // Relief caps total (pre-cess) tax at "tax at exactly ₹50L, plus the ₹100 of
      // excess income" — so the surcharge component must be a tiny, ₹100-scale
      // amount, nowhere near what an unrelieved 10% surcharge on ~₹10L+ of base tax
      // would be (tens of thousands of rupees). A generous ₹1,000 ceiling avoids
      // hand-computing the exact new-regime base-tax bracket sum here while still
      // being a meaningful, failure-catching assertion.
      expect(Number(result.newRegime.surcharge)).toBeLessThan(1000);
      expect(Number(result.newRegime.surcharge)).toBeGreaterThanOrEqual(0);
    });

    it("does not apply relief for income comfortably past a threshold (regression guard alongside the pre-existing ₹83.5L test above)", async () => {
      mockIncomeService.monthlyForecast.mockResolvedValue(700000);
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2025-26");

      expect(result.oldRegime.marginalReliefApplied).toBe(false);
    });
  });

  describe("capital gains (new, audit item #11)", () => {
    beforeEach(() => {
      mockIncomeService.monthlyForecast.mockResolvedValue(100000); // 12L/year
      mockIncomeService.list.mockResolvedValue([]);
      mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);
    });

    it("returns all-zero capital gains when no realized gains are logged for the year", async () => {
      mockPrisma.client.realizedGainEvent.findMany.mockResolvedValue([]);

      const result = await service.estimate("user-1", "2025-26");

      expect(Number(result.capitalGains.totalCapitalGainsTax)).toBe(0);
      expect(result.capitalGains.financialYear).toBe("2025-26");
      expect(result.capitalGains.isProjectionOnly).toBe(true);
    });

    it("taxes an equity long-term gain at 12.5% above the ₹1,25,000 exemption", async () => {
      mockPrisma.client.realizedGainEvent.findMany.mockResolvedValue([
        { gainCategory: "EQUITY_LONG_TERM", gainAmount: 300000 },
      ]);

      const result = await service.estimate("user-1", "2025-26");

      expect(Number(result.capitalGains.equityLongTermTax)).toBeCloseTo((300000 - 125000) * 0.125, 2);
    });

    it("only queries realized gains for the requested financial year", async () => {
      mockPrisma.client.realizedGainEvent.findMany.mockResolvedValue([]);

      await service.estimate("user-1", "2025-26");

      expect(mockPrisma.client.realizedGainEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1", financialYear: "2025-26" } }),
      );
    });

    it("computes otherShortTermTax at the marginal slab rate on top of the person's other taxable income", async () => {
      mockPrisma.client.realizedGainEvent.findMany.mockResolvedValue([
        { gainCategory: "OTHER_SHORT_TERM", gainAmount: 200000 },
      ]);

      const result = await service.estimate("user-1", "2025-26");

      // 12L/year old-regime taxable income (no deductions) sits in the 30% bracket
      // (>10L) for FY2025-26's old-regime slabs — so ₹200,000 of additional
      // short-term "other asset" gain should be taxed at (close to) 30% marginal,
      // not 0% or some flat capital-gains rate.
      expect(Number(result.capitalGains.otherShortTermTax)).toBeCloseTo(200000 * 0.3, 2);
    });

    it("does not let capitalGains affect oldRegime/newRegime.taxPayable — it's a separate line item", async () => {
      const withoutGains = await service.estimate("user-1", "2025-26");

      mockPrisma.client.realizedGainEvent.findMany.mockResolvedValue([
        { gainCategory: "EQUITY_LONG_TERM", gainAmount: 500000 },
      ]);
      const withGains = await service.estimate("user-1", "2025-26");

      expect(withGains.oldRegime.taxPayable).toBe(withoutGains.oldRegime.taxPayable);
      expect(withGains.newRegime.taxPayable).toBe(withoutGains.newRegime.taxPayable);
      expect(Number(withGains.capitalGains.totalCapitalGainsTax)).toBeGreaterThan(0);
    });
  });
});
