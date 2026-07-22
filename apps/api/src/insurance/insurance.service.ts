import { Injectable, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { CreatePolicyDto } from "./dto/create-policy.dto";
import { UpdatePolicyDto } from "./dto/update-policy.dto";
import { CoverageGapDTO, InsuranceType } from "@wealthos/types";

// Coverage rules of thumb used for gap analysis. These are common planning heuristics,
// not personalized advice — surfaced to the user with that framing, never as a guarantee.
const TERM_INCOME_MULTIPLE = 10;
const ACCIDENT_INCOME_MULTIPLE = 5;
const HEALTH_BASE_COVERAGE = 500000; // ₹5L floor, common baseline for a metro Indian family
const HEALTH_PER_DEPENDENT = 300000; // ₹3L per additional dependent

@Injectable()
export class InsuranceService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
  ) {}

  list(userId: string) {
    return this.prisma.client.insurancePolicy.findMany({
      where: { userId },
      orderBy: { renewalDate: "asc" },
    });
  }

  async create(userId: string, dto: CreatePolicyDto) {
    return this.prisma.client.insurancePolicy.create({
      data: { ...dto, userId, renewalDate: new Date(dto.renewalDate) },
    });
  }

  async update(userId: string, id: string, dto: UpdatePolicyDto) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.insurancePolicy.update({
      where: { id },
      data: { ...dto, renewalDate: dto.renewalDate ? new Date(dto.renewalDate) : undefined },
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.insurancePolicy.delete({ where: { id } });
  }

  async upcomingRenewals(userId: string, withinDays = 60) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + withinDays);
    return this.prisma.client.insurancePolicy.findMany({
      where: { userId, renewalDate: { lte: cutoff } },
      orderBy: { renewalDate: "asc" },
    });
  }

  async gapAnalysis(userId: string): Promise<CoverageGapDTO[]> {
    const [policies, monthlyIncome, user] = await Promise.all([
      this.list(userId),
      this.incomeService.monthlyForecast(userId),
      this.prisma.client.user.findUnique({
        where: { id: userId },
        include: { household: { include: { dependents: true } } },
      }),
    ]);
    const annualIncome = monthlyIncome * 12;
    const dependentCount = user?.household?.dependents.length ?? 0;

    const termCoverage = this.totalCoverageByType(policies, "TERM");
    const healthCoverage = this.totalCoverageByType(policies, "HEALTH");
    const accidentCoverage = this.totalCoverageByType(policies, "PERSONAL_ACCIDENT");

    const recommendedTerm = annualIncome * TERM_INCOME_MULTIPLE;
    const recommendedHealth = HEALTH_BASE_COVERAGE + dependentCount * HEALTH_PER_DEPENDENT;
    const recommendedAccident = annualIncome * ACCIDENT_INCOME_MULTIPLE;

    return [
      this.buildGap("TERM", termCoverage, recommendedTerm, "Term life"),
      this.buildGap("HEALTH", healthCoverage, recommendedHealth, "Health"),
      this.buildGap("PERSONAL_ACCIDENT", accidentCoverage, recommendedAccident, "Personal accident"),
    ];
  }

  private totalCoverageByType(policies: { type: string; coverageAmount: unknown }[], type: string): number {
    return policies
      .filter((p) => p.type === type)
      .reduce((sum, p) => sum + Number(p.coverageAmount), 0);
  }

  private buildGap(
    type: InsuranceType,
    current: number,
    recommended: number,
    label: string,
  ): CoverageGapDTO {
    const gap = Math.max(0, recommended - current);
    const hasCoverage = current > 0;
    const message =
      gap === 0
        ? `${label} coverage looks adequate against the rule-of-thumb benchmark.`
        : hasCoverage
          ? `${label} coverage is below the typical benchmark for this income/household by roughly this amount.`
          : `No ${label.toLowerCase()} policy found — this is a common and significant protection gap.`;

    return {
      type,
      hasCoverage,
      currentCoverage: current.toFixed(2),
      recommendedCoverage: recommended.toFixed(2),
      gap: gap.toFixed(2),
      message,
    };
  }

  // Nominee tracking: a household-governance view of which policies have (or lack) a
  // nominee on file — useful for family financial hygiene, surfaced on the Protect page.
  async nomineeSummary(userId: string) {
    const policies = await this.list(userId);
    return {
      totalPolicies: policies.length,
      withNominee: policies.filter((p) => !!p.nomineeName).length,
      missingNominee: policies
        .filter((p) => !p.nomineeName)
        .map((p) => ({ id: p.id, provider: p.provider, type: p.type })),
    };
  }

  private async assertOwnership(userId: string, policyId: string) {
    const policy = await this.prisma.client.insurancePolicy.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundException("Policy not found");
    if (policy.userId !== userId) throw new ForbiddenException();
  }
}
