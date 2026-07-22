import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateRetirementProfileDto } from "./dto/update-retirement-profile.dto";
import { calculateAge } from "../common/utils/age.util";
import { RetirementPlanDTO } from "@wealthos/types";

const RETIREMENT_INVESTMENT_TYPES = ["EPF", "PPF", "NPS"];
const POST_RETIREMENT_HORIZON_YEARS = 25; // assumed years of retirement drawdown

@Injectable()
export class RetirementService {
  constructor(private prisma: PrismaService) {}

  async getOrCreateProfile(userId: string) {
    const existing = await this.prisma.client.retirementProfile.findUnique({ where: { userId } });
    if (existing) return existing;

    return this.prisma.client.retirementProfile.create({
      data: { userId, desiredMonthlyIncomeToday: 50000 },
    });
  }

  async updateProfile(userId: string, dto: UpdateRetirementProfileDto) {
    await this.getOrCreateProfile(userId);
    return this.prisma.client.retirementProfile.update({
      where: { userId },
      data: dto,
    });
  }

  // Projections only — a rough educational estimate, not a certified retirement plan.
  // Assumes a 25-year drawdown horizon and a constant real return during retirement.
  async computePlan(userId: string): Promise<RetirementPlanDTO> {
    const [profile, user, investments, retirementGoals] = await Promise.all([
      this.getOrCreateProfile(userId),
      this.prisma.client.user.findUnique({ where: { id: userId } }),
      this.prisma.client.investment.findMany({ where: { userId } }),
      this.prisma.client.goal.findMany({ where: { userId, type: "RETIREMENT" } }),
    ]);

    const currentAge = calculateAge(user?.dateOfBirth);

    const yearsToRetirement = Math.max(1, profile.targetRetirementAge - currentAge);

    const inflation = Number(profile.inflationRatePercent) / 100;
    const preReturn = Number(profile.expectedReturnPreRetirementPercent) / 100;
    const postReturn = Number(profile.expectedReturnPostRetirementPercent) / 100;

    const monthlyIncomeAtRetirement =
      Number(profile.desiredMonthlyIncomeToday) * Math.pow(1 + inflation, yearsToRetirement);

    const realReturnPostRetirement = postReturn - inflation;
    const annualIncomeAtRetirement = monthlyIncomeAtRetirement * 12;
    const corpusRequired =
      Math.abs(realReturnPostRetirement) < 0.001
        ? annualIncomeAtRetirement * POST_RETIREMENT_HORIZON_YEARS
        : (annualIncomeAtRetirement * (1 - Math.pow(1 + realReturnPostRetirement, -POST_RETIREMENT_HORIZON_YEARS))) /
          realReturnPostRetirement;

    const retirementInvestmentValue = investments
      .filter((i) => RETIREMENT_INVESTMENT_TYPES.includes(i.type))
      .reduce((sum, i) => sum + Number(i.currentValue), 0);
    const retirementGoalValue = retirementGoals.reduce((sum, g) => sum + Number(g.currentAmount), 0);
    const currentRetirementCorpus = retirementInvestmentValue + retirementGoalValue;

    const projectedCurrentCorpusAtRetirement =
      currentRetirementCorpus * Math.pow(1 + preReturn, yearsToRetirement);

    const corpusGap = Math.max(0, corpusRequired - projectedCurrentCorpusAtRetirement);

    const months = yearsToRetirement * 12;
    const monthlyPreReturn = preReturn / 12;
    const requiredMonthlySip =
      corpusGap <= 0
        ? 0
        : Math.abs(monthlyPreReturn) < 0.0001
          ? corpusGap / months
          : (corpusGap * monthlyPreReturn) / (Math.pow(1 + monthlyPreReturn, months) - 1);

    return {
      yearsToRetirement,
      monthlyIncomeAtRetirement: monthlyIncomeAtRetirement.toFixed(2),
      corpusRequired: corpusRequired.toFixed(2),
      currentRetirementCorpus: currentRetirementCorpus.toFixed(2),
      corpusGap: corpusGap.toFixed(2),
      requiredMonthlySip: requiredMonthlySip.toFixed(2),
      onTrack: corpusGap <= 0,
      isProjectionOnly: true,
    };
  }
}
