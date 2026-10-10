import { Injectable } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import type {
  PortfolioProjectionDTO,
  PortfolioProjectionHoldingDTO,
  ProjectionCurvePointDTO,
  ProjectionDTO,
  ProjectionScenarioDTO,
} from "@wealthos/types";
import { PrismaService } from "../prisma/prisma.service";
import { CadenceName, GrowthProjection, projectGrowth, toDecimal, toMoneyString } from "../common/financial-facts/financial-formulas";
import { sipOccurrences } from "./investment-sip.util";
import { DEFAULT_PROJECTION_YEARS, PortfolioProjectionQueryDto, ProjectionQueryDto } from "./dto/projection-query.dto";

const ZERO = new Prisma.Decimal(0);

export const PROJECTION_DISCLAIMER =
  "A projection, not a promise: it assumes the same return every year and is built only from the numbers shown. Real returns vary and can be negative.";

interface HoldingInput {
  currentValue: Prisma.Decimal;
  contributionPerPeriod: Prisma.Decimal;
  cadence: CadenceName;
  annualReturnPercent: Prisma.Decimal;
  contributionPeriods: number | null;
}

const scenarioDto = (p: GrowthProjection): ProjectionScenarioDTO => ({
  years: p.years,
  totalContributions: toMoneyString(p.totalContributions),
  principal: toMoneyString(p.principal),
  projectedValue: toMoneyString(p.projectedValue),
  projectedGain: toMoneyString(p.projectedGain),
});

// Deterministic projections. PROJECTED values are computed here from stated assumptions and returned
// SEPARATELY from actual values — nothing in this service reads a projection back into a holding, a
// valuation or a contribution, so a projection can never overwrite or masquerade as an actual.
@Injectable()
export class InvestmentProjectionService {
  constructor(private prisma: PrismaService) {}

  private horizons(years?: number[]): number[] {
    return years && years.length > 0 ? years : DEFAULT_PROJECTION_YEARS;
  }

  /** Yearly points from year 0 to the longest horizon, for the growth-curve chart. */
  private curveOf(items: HoldingInput[], maxYears: number): ProjectionCurvePointDTO[] {
    const points: ProjectionCurvePointDTO[] = [];
    for (let year = 0; year <= maxYears; year++) {
      let principal = ZERO;
      let value = ZERO;
      for (const it of items) {
        const p = projectGrowth({ ...it, years: year });
        principal = principal.plus(p.principal);
        value = value.plus(p.projectedValue);
      }
      points.push({ year, principal: toMoneyString(principal), projectedValue: toMoneyString(value) });
    }
    return points;
  }

  /** Several holdings' projections for one horizon, summed. */
  private sumScenario(items: HoldingInput[], years: number): ProjectionScenarioDTO {
    let totalContributions = ZERO;
    let principal = ZERO;
    let projectedValue = ZERO;
    for (const it of items) {
      const p = projectGrowth({ ...it, years });
      totalContributions = totalContributions.plus(p.totalContributions);
      principal = principal.plus(p.principal);
      projectedValue = projectedValue.plus(p.projectedValue);
    }
    return {
      years,
      totalContributions: toMoneyString(totalContributions),
      principal: toMoneyString(principal),
      projectedValue: toMoneyString(projectedValue),
      projectedGain: toMoneyString(projectedValue.minus(principal)),
    };
  }

  /** The stateless "what if" calculator. Reads and writes nothing. */
  calculate(q: ProjectionQueryDto): ProjectionDTO {
    const cadence = (q.frequency ?? "MONTHLY") as CadenceName;
    const input: HoldingInput = {
      currentValue: new Prisma.Decimal(q.currentValue ?? 0),
      contributionPerPeriod: new Prisma.Decimal(q.contribution ?? 0),
      cadence,
      annualReturnPercent: new Prisma.Decimal(q.annualReturn),
      contributionPeriods: null,
    };
    const years = this.horizons(q.years);
    return {
      basis: "PROJECTED",
      disclaimer: PROJECTION_DISCLAIMER,
      assumptions: {
        currentValue: toMoneyString(input.currentValue),
        contributionPerPeriod: toMoneyString(input.contributionPerPeriod),
        frequency: cadence,
        annualReturnPercent: input.annualReturnPercent.toString(),
      },
      scenarios: years.map((y) => scenarioDto(projectGrowth({ ...input, years: y }))),
      curve: this.curveOf([input], Math.max(...years)),
    };
  }

  /** Projects the user's actual holdings and active schedules, each with its own return assumption. */
  async portfolio(userId: string, q: PortfolioProjectionQueryDto, asOf: Date = new Date()): Promise<PortfolioProjectionDTO> {
    const rows = await this.prisma.client.investment.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        type: true,
        currentValue: true,
        sipActive: true,
        monthlyContribution: true,
        contributionDay: true,
        contributionFrequency: true,
        contributionStartDate: true,
        contributionEndDate: true,
        expectedAnnualReturn: true,
      },
      orderBy: { currentValue: "desc" },
    });

    const defaultRate = q.annualReturn !== undefined ? new Prisma.Decimal(q.annualReturn) : null;
    const items: HoldingInput[] = [];
    const holdings: PortfolioProjectionHoldingDTO[] = [];
    let actualTotal = ZERO;
    let includedValue = ZERO;

    for (const inv of rows) {
      const value = toDecimal(inv.currentValue);
      actualTotal = actualTotal.plus(value);

      // The holding's own assumption wins; otherwise the caller's default; otherwise it is excluded —
      // a projection is never run on a return nobody chose.
      const own = inv.expectedAnnualReturn !== null && inv.expectedAnnualReturn !== undefined ? toDecimal(inv.expectedAnnualReturn) : null;
      const rate = own ?? defaultRate;
      const rateSource: PortfolioProjectionHoldingDTO["rateSource"] = own ? "INVESTMENT" : defaultRate ? "DEFAULT" : "NONE";

      // Contributions only while an ACTIVE schedule is still running.
      const cadence = ((inv.contributionFrequency as CadenceName | null) ?? "MONTHLY") as CadenceName;
      const hasSchedule = inv.sipActive && inv.monthlyContribution && inv.contributionStartDate;
      const perPeriod = hasSchedule ? toDecimal(inv.monthlyContribution) : ZERO;
      let contributionPeriods: number | null = null;
      if (hasSchedule && inv.contributionEndDate) {
        // Periods still to come before the schedule ends (an ended schedule contributes nothing more).
        contributionPeriods = sipOccurrences(
          { frequency: cadence, contributionDay: inv.contributionDay ?? inv.contributionStartDate!.getUTCDate(), startDate: inv.contributionStartDate!, endDate: inv.contributionEndDate },
          inv.contributionEndDate,
          { after: asOf },
        ).length;
      }

      const included = rate !== null;
      holdings.push({
        id: inv.id,
        name: inv.name,
        type: inv.type as PortfolioProjectionHoldingDTO["type"],
        currentValue: toMoneyString(value),
        annualReturnPercent: rate ? rate.toString() : null,
        rateSource,
        contributionPerPeriod: hasSchedule ? toMoneyString(perPeriod) : null,
        frequency: hasSchedule ? cadence : null,
        included,
      });
      if (included && rate) {
        includedValue = includedValue.plus(value);
        items.push({ currentValue: value, contributionPerPeriod: perPeriod, cadence, annualReturnPercent: rate, contributionPeriods });
      }
    }

    const years = this.horizons(q.years);
    return {
      basis: "PROJECTED",
      disclaimer: PROJECTION_DISCLAIMER,
      actual: { basis: "ACTUAL", currentValue: toMoneyString(actualTotal), holdings: rows.length },
      defaultAnnualReturnPercent: defaultRate ? defaultRate.toString() : null,
      includedValueToday: toMoneyString(includedValue),
      scenarios: items.length ? years.map((y) => this.sumScenario(items, y)) : [],
      curve: items.length ? this.curveOf(items, Math.max(...years)) : [],
      holdings,
      includedCount: items.length,
      excludedCount: rows.length - items.length,
    };
  }
}
