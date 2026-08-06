import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateRetirementProfileDto } from "./dto/update-retirement-profile.dto";
import { calculateAge } from "../common/utils/age.util";
import { RetirementPlanDTO } from "@wealthos/types";

const RETIREMENT_INVESTMENT_TYPES = ["EPF", "PPF", "NPS"];
// Fallback drawdown horizon, used whenever the profile hasn't set a life expectancy (or
// has set one that isn't actually later than the target retirement age). This is the
// exact figure the calculation always used before this change — every existing profile,
// having never had a lifeExpectancyAge field to set, gets byte-identical output.
const DEFAULT_POST_RETIREMENT_HORIZON_YEARS = 25;

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
  //
  // Two previously-flagged simplifications are now addressed, both strictly opt-in via
  // new optional profile fields — a profile that hasn't set them gets EXACTLY the same
  // output as before this change (verified by the two pre-existing tests, unmodified):
  //
  // 1. DRAWDOWN HORIZON: was a flat 25 years regardless of actual life expectancy or
  //    retirement age. If the profile has a lifeExpectancyAge set AND it's actually
  //    later than targetRetirementAge (otherwise the resulting "horizon" would be zero
  //    or negative, which is meaningless — silently falls back to the 25-year default
  //    in that case rather than producing a nonsensical near-zero corpus requirement),
  //    the horizon becomes (lifeExpectancyAge - targetRetirementAge) instead.
  //
  // 2. PENSION/ANNUITY INCOME: previously assumed the ENTIRE desired monthly income at
  //    retirement had to come from the self-funded corpus. If the profile has an
  //    expectedMonthlyPensionAtRetirement set (e.g. an EPS or employer pension the user
  //    expects to receive, already expressed in nominal rupees AT the retirement date —
  //    the same "already future-valued" convention monthlyIncomeAtRetirement uses, not
  //    today's rupees), that guaranteed income offsets how much the corpus itself needs
  //    to fund, reducing corpusRequired accordingly.
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

    // Rounded to the nearest cent immediately, and that rounded figure (not the raw
    // float) is what every downstream calculation — pension offset, net income needed,
    // corpus required — is derived from. This keeps the value byte-identical to what's
    // actually returned in monthlyIncomeAtRetirement below, so a caller who reads that
    // field back and does its own math with it (e.g. "30% of my monthly income at
    // retirement as a pension offset") gets numbers that reconcile exactly rather than
    // drifting by a fraction of a rupee against this service's own unrounded internals.
    const monthlyIncomeAtRetirement = Number(
      (Number(profile.desiredMonthlyIncomeToday) * Math.pow(1 + inflation, yearsToRetirement)).toFixed(2),
    );

    // Pension/annuity offset (new). Unset or non-positive -> no offset, identical to
    // the original behavior.
    const monthlyPensionOffset = Math.max(
      0,
      Math.min(Number(profile.expectedMonthlyPensionAtRetirement ?? 0), monthlyIncomeAtRetirement),
    );
    const netMonthlyIncomeNeededFromCorpus = monthlyIncomeAtRetirement - monthlyPensionOffset;

    // Life-expectancy-aware horizon (new). Falls back to the original flat default
    // whenever lifeExpectancyAge is unset, or set to a value that wouldn't produce a
    // sensible positive horizon.
    const lifeExpectancyAge = profile.lifeExpectancyAge ?? null;
    const isHorizonFromLifeExpectancy = lifeExpectancyAge !== null && lifeExpectancyAge > profile.targetRetirementAge;
    const drawdownHorizonYears = isHorizonFromLifeExpectancy
      ? lifeExpectancyAge! - profile.targetRetirementAge
      : DEFAULT_POST_RETIREMENT_HORIZON_YEARS;

    const realReturnPostRetirement = postReturn - inflation;
    const annualIncomeNeededFromCorpus = netMonthlyIncomeNeededFromCorpus * 12;
    const corpusRequired =
      Math.abs(realReturnPostRetirement) < 0.001
        ? annualIncomeNeededFromCorpus * drawdownHorizonYears
        : (annualIncomeNeededFromCorpus *
            (1 - Math.pow(1 + realReturnPostRetirement, -drawdownHorizonYears))) /
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
      drawdownHorizonYears,
      isHorizonFromLifeExpectancy,
      monthlyPensionOffset: monthlyPensionOffset.toFixed(2),
      netMonthlyIncomeNeededFromCorpus: netMonthlyIncomeNeededFromCorpus.toFixed(2),
    };
  }
}
