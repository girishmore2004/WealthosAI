import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { CreateDeductionDto } from "./dto/create-deduction.dto";
import { financialYearRange } from "../common/utils/financial-year.util";
import { TaxEstimateDTO, TaxSection } from "@wealthos/types";

// Deduction limits are simplified, illustrative caps under the OLD regime (FY2025-26 rules).
// The NEW regime disallows most of these — only the standard deduction applies there.
// This engine is for education/decision-support only, not a substitute for a CA or the
// official IT department calculator, and slabs/limits change with each Union Budget.
const SECTION_LIMITS: Partial<Record<TaxSection, number>> = {
  SECTION_80C: 150000,
  SECTION_80D: 25000,
  SECTION_80CCD_1B: 50000,
  HOME_LOAN_INTEREST: 200000,
  SECTION_80TTA: 10000,
};

const STANDARD_DEDUCTION_OLD = 50000;
const STANDARD_DEDUCTION_NEW = 75000;

function oldRegimeTax(taxableIncome: number): number {
  const slabs: [number, number, number][] = [
    [0, 250000, 0],
    [250000, 500000, 0.05],
    [500000, 1000000, 0.2],
    [1000000, Infinity, 0.3],
  ];
  return applySlabs(taxableIncome, slabs);
}

function newRegimeTax(taxableIncome: number): number {
  // FY2025-26 new-regime slabs (Budget 2025), with Section 87A rebate making tax effectively
  // nil up to ₹12L taxable income.
  if (taxableIncome <= 1200000) return 0;
  const slabs: [number, number, number][] = [
    [0, 400000, 0],
    [400000, 800000, 0.05],
    [800000, 1200000, 0.1],
    [1200000, 1600000, 0.15],
    [1600000, 2000000, 0.2],
    [2000000, 2400000, 0.25],
    [2400000, Infinity, 0.3],
  ];
  return applySlabs(taxableIncome, slabs);
}

function applySlabs(income: number, slabs: [number, number, number][]): number {
  let tax = 0;
  for (const [from, to, rate] of slabs) {
    if (income <= from) break;
    const taxableInSlab = Math.min(income, to) - from;
    tax += taxableInSlab * rate;
  }
  // 4% health & education cess
  return tax * 1.04;
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
      const limit = SECTION_LIMITS[section];
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
      grossAnnualIncome - STANDARD_DEDUCTION_OLD - totalOldRegimeDeductions,
    );
    const newTaxableIncome = Math.max(0, grossAnnualIncome - STANDARD_DEDUCTION_NEW);

    const oldTax = oldRegimeTax(oldTaxableIncome);
    const newTax = newRegimeTax(newTaxableIncome);
    const recommendedRegime = oldTax <= newTax ? "OLD" : "NEW";

    return {
      financialYear,
      grossAnnualIncome: grossAnnualIncome.toFixed(2),
      totalDeductions: totalOldRegimeDeductions.toFixed(2),
      oldRegime: { taxableIncome: oldTaxableIncome.toFixed(2), taxPayable: oldTax.toFixed(2) },
      newRegime: { taxableIncome: newTaxableIncome.toFixed(2), taxPayable: newTax.toFixed(2) },
      recommendedRegime,
      savingsFromRecommendedRegime: Math.abs(oldTax - newTax).toFixed(2),
      deductionsBySection,
      yearEndChecklist: this.yearEndChecklist(bySection),
      isProjectionOnly: true,
    };
  }

  private yearEndChecklist(bySection: Map<TaxSection, number>): string[] {
    const checklist: string[] = [];
    const used80C = bySection.get("SECTION_80C") ?? 0;
    if (used80C < 150000) {
      checklist.push(
        `₹${(150000 - used80C).toLocaleString("en-IN")} of Section 80C room is still unused this year (ELSS, PPF, EPF, life insurance premium, etc.).`,
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
