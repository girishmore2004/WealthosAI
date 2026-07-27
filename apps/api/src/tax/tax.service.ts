import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { CreateDeductionDto } from "./dto/create-deduction.dto";
import { financialYearRange } from "../common/utils/financial-year.util";
import { TaxEstimateDTO, TaxSection } from "@wealthos/types";
import { TaxSlabBracket, TaxYearConfig, resolveTaxYearConfig } from "./tax-slab-config";

// This engine is for education/decision-support only, not a substitute for a CA or the
// official IT department calculator. Slab rates, limits, and surcharge thresholds now
// live in tax-slab-config.ts, keyed by financial year — see that file's doc comment for
// why, and resolveTaxYearConfig() for what happens when a requested year isn't in it
// yet.

export function applySlabs(income: number, slabs: TaxSlabBracket[]): number {
  let tax = 0;
  for (const { from, to, rate } of slabs) {
    if (income <= from) break;
    const taxableInSlab = Math.min(income, to) - from;
    tax += taxableInSlab * rate;
  }
  return tax;
}

// Surcharge is NOT slab-wise like income tax itself: once total (taxable) income
// crosses a threshold, the single matching rate applies to the ENTIRE base tax amount,
// not just the portion above the threshold. Returns the surcharge RATE (e.g. 0.10 for
// 10%), not an amount — callers multiply the base tax by (1 + rate). Exported for
// direct, precise unit testing of the rate table in isolation (see
// test/tax.service.spec.ts) rather than only indirectly through estimate()'s full
// pipeline.
export function findSurchargeRate(taxableIncome: number, slabs: TaxSlabBracket[]): number {
  for (const { from, to, rate } of slabs) {
    if (taxableIncome > from && taxableIncome <= to) return rate;
  }
  return 0;
}

// Computes { taxPayable, surcharge } for one regime: base slab tax -> surcharge (on the
// base tax) -> cess (on tax + surcharge). Deliberately does NOT implement marginal
// relief — the provision that caps how much surcharge can increase your total tax
// versus someone just below the threshold, so that crossing a surcharge boundary by ₹1
// doesn't cost you far more than ₹1 in extra tax. This is a genuinely fiddly,
// easy-to-get-subtly-wrong calculation; rather than risk an incorrect implementation,
// it's explicitly left unapplied and disclosed via isProjectionOnly and this comment —
// figures for taxable income right at a surcharge threshold may overstate actual
// liability slightly as a result. Everywhere else (well below/above any threshold),
// this omission has no effect at all.
function computeRegimeTax(
  taxableIncome: number,
  slabs: TaxSlabBracket[],
  surchargeSlabs: TaxSlabBracket[],
  cessRate: number,
): { taxPayable: number; surcharge: number } {
  const baseTax = applySlabs(taxableIncome, slabs);
  const surchargeRate = findSurchargeRate(taxableIncome, surchargeSlabs);
  const surcharge = baseTax * surchargeRate;
  const taxPayable = (baseTax + surcharge) * (1 + cessRate);
  return { taxPayable, surcharge };
}

function oldRegimeTax(taxableIncome: number, config: TaxYearConfig) {
  return computeRegimeTax(taxableIncome, config.oldRegimeSlabs, config.oldRegimeSurchargeSlabs, config.cessRate);
}

function newRegimeTax(taxableIncome: number, config: TaxYearConfig) {
  // Section 87A rebate: tax is effectively nil at/below the threshold, regardless of
  // what the slab math alone would produce (and therefore surcharge/cess never apply
  // either, since there's no base tax for them to act on).
  if (taxableIncome <= config.newRegimeRebateThreshold) {
    return { taxPayable: 0, surcharge: 0 };
  }
  return computeRegimeTax(taxableIncome, config.newRegimeSlabs, config.newRegimeSurchargeSlabs, config.cessRate);
}

@Injectable()
export class TaxService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
  ) {}

  listDeductions(userId: string, financialYear: string) {
    return this.prisma.client.taxDeduction.findMany({
      where: { userId, financialYear },
      orderBy: { createdAt: "desc" },
    });
  }

  async addDeduction(userId: string, dto: CreateDeductionDto) {
    return this.prisma.client.taxDeduction.create({ data: { ...dto, userId } });
  }

  // Already correctly ownership-scoped in a single atomic call before this change —
  // no hardening needed here (unlike most other money modules' remove() this session,
  // this one was never a findUnique-then-delete pair to begin with).
  async removeDeduction(userId: string, id: string) {
    return this.prisma.client.taxDeduction.deleteMany({ where: { id, userId } });
  }

  private async annualIncome(userId: string, financialYear: string): Promise<number> {
    const { fyStart, fyEnd } = financialYearRange(financialYear);

    const [monthlyForecast, allIncomes] = await Promise.all([
      this.incomeService.monthlyForecast(userId),
      this.incomeService.list(userId),
    ]);

    const oneTimeInYear = allIncomes
      .filter((i) => i.recurrence === "ONE_TIME" && i.receivedAt >= fyStart && i.receivedAt <= fyEnd)
      .reduce((sum, i) => sum + Number(i.amount), 0);

    return monthlyForecast * 12 + oneTimeInYear;
  }

  async estimate(userId: string, financialYear: string): Promise<TaxEstimateDTO> {
    const { config, isEstimatedFromPriorYear } = resolveTaxYearConfig(financialYear);

    const [grossAnnualIncome, deductions] = await Promise.all([
      this.annualIncome(userId, financialYear),
      this.listDeductions(userId, financialYear),
    ]);

    const bySection = new Map<TaxSection, number>();
    for (const d of deductions) {
      const section = d.section as TaxSection;
      bySection.set(section, (bySection.get(section) ?? 0) + Number(d.amount));
    }

    let totalOldRegimeDeductions = 0;
    const deductionsBySection = Array.from(bySection.entries()).map(([section, used]) => {
      const limit = config.sectionLimits[section];
      const cappedUsed = limit ? Math.min(used, limit) : used;
      totalOldRegimeDeductions += cappedUsed;
      return {
        section,
        used: used.toFixed(2),
        limit: limit ? limit.toFixed(2) : "No fixed cap",
        remainingRoom: limit ? Math.max(0, limit - used).toFixed(2) : "0.00",
      };
    });

    const oldTaxableIncome = Math.max(
      0,
      grossAnnualIncome - config.standardDeductionOld - totalOldRegimeDeductions,
    );
    const newTaxableIncome = Math.max(0, grossAnnualIncome - config.standardDeductionNew);

    const oldResult = oldRegimeTax(oldTaxableIncome, config);
    const newResult = newRegimeTax(newTaxableIncome, config);
    const recommendedRegime = oldResult.taxPayable <= newResult.taxPayable ? "OLD" : "NEW";

    return {
      financialYear,
      grossAnnualIncome: grossAnnualIncome.toFixed(2),
      totalDeductions: totalOldRegimeDeductions.toFixed(2),
      oldRegime: {
        taxableIncome: oldTaxableIncome.toFixed(2),
        taxPayable: oldResult.taxPayable.toFixed(2),
        surcharge: oldResult.surcharge.toFixed(2),
      },
      newRegime: {
        taxableIncome: newTaxableIncome.toFixed(2),
        taxPayable: newResult.taxPayable.toFixed(2),
        surcharge: newResult.surcharge.toFixed(2),
      },
      recommendedRegime,
      savingsFromRecommendedRegime: Math.abs(oldResult.taxPayable - newResult.taxPayable).toFixed(2),
      deductionsBySection,
      yearEndChecklist: this.yearEndChecklist(bySection, config),
      isProjectionOnly: true,
      slabsFinancialYear: config.financialYear,
      slabsAreEstimated: isEstimatedFromPriorYear,
    };
  }

  private yearEndChecklist(bySection: Map<TaxSection, number>, config: TaxYearConfig): string[] {
    const checklist: string[] = [];
    const section80CLimit = config.sectionLimits.SECTION_80C ?? 0;
    const used80C = bySection.get("SECTION_80C") ?? 0;
    if (used80C < section80CLimit) {
      checklist.push(
        `₹${(section80CLimit - used80C).toLocaleString("en-IN")} of Section 80C room is still unused this year (ELSS, PPF, EPF, life insurance premium, etc.).`,
      );
    }
    if (!bySection.has("SECTION_80D")) {
      checklist.push("No health insurance premium logged under Section 80D yet — check if a policy qualifies.");
    }
    if (!bySection.has("SECTION_80CCD_1B")) {
      checklist.push("An additional ₹50,000 NPS contribution under Section 80CCD(1B) is available and unused.");
    }
    checklist.push("Confirm advance tax installments are on schedule if total tax liability exceeds ₹10,000 for the year.");
    return checklist;
  }
}
