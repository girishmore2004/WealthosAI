import { Injectable } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import type { InvestmentAnalyticsDTO } from "@wealthos/types";
import { PrismaService } from "../prisma/prisma.service";
import { annualContribution, monthlyEquivalent, percentOf, toDecimal, toMoneyString, CadenceName } from "../common/financial-facts/financial-formulas";
import { currentMonthString } from "../common/utils/financial-period.util";
import { MonthlyCashflowRow, MonthlyValuationRow, buildInvestmentSeries, monthWindow } from "./investment-analytics.util";

const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 36;
const ZERO = new Prisma.Decimal(0);

// ACTUAL, ledger-derived analytics for the investments page: contribution, value and gain trends plus
// what the schedules plan to contribute. Aggregation happens in Postgres (one grouped query per
// table, rows bounded by holdings x months) — no transaction list is ever sent to the browser.
@Injectable()
export class InvestmentAnalyticsService {
  constructor(private prisma: PrismaService) {}

  async analytics(userId: string, monthsRequested?: number, now: Date = new Date()): Promise<InvestmentAnalyticsDTO> {
    const count = Math.min(Math.max(1, Math.floor(monthsRequested ?? DEFAULT_MONTHS)), MAX_MONTHS);
    const currentMonth = currentMonthString(now);
    const months = monthWindow(currentMonth, count);
    const [y, m] = currentMonth.split("-").map(Number);
    const nextMonthStart = new Date(Date.UTC(y, m, 1));

    const [cashRows, valuationRows, holdings] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ investmentId: string; month: string; type: MonthlyCashflowRow["type"]; total: Prisma.Decimal }>>(Prisma.sql`
        SELECT "investmentId",
               to_char("occurredAt" AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
               "type"::text AS type,
               SUM("amount") AS total
        FROM "InvestmentCashflow"
        WHERE "userId" = ${userId} AND "occurredAt" < ${nextMonthStart}
        GROUP BY 1, 2, 3
      `),
      // The latest valuation each holding had in each month (DISTINCT ON keeps the newest per month).
      this.prisma.client.$queryRaw<Array<{ investmentId: string; month: string; value: Prisma.Decimal }>>(Prisma.sql`
        SELECT DISTINCT ON ("investmentId", month) "investmentId", month, "value"
        FROM (
          SELECT "investmentId", "value", "valuedAt", to_char("valuedAt" AT TIME ZONE 'UTC', 'YYYY-MM') AS month
          FROM "InvestmentValuation"
          WHERE "userId" = ${userId} AND "valuedAt" < ${nextMonthStart}
        ) v
        ORDER BY "investmentId", month, "valuedAt" DESC
      `),
      this.prisma.client.investment.findMany({
        where: { userId },
        select: { id: true, type: true, riskLevel: true, liquidity: true, currentValue: true, sipActive: true, monthlyContribution: true, contributionFrequency: true, contributionStartDate: true, contributionEndDate: true },
      }),
    ]);

    const series = buildInvestmentSeries(months, cashRows, valuationRows as MonthlyValuationRow[], currentMonth);

    // PLANNED contributions: only schedules that are active and have not already ended.
    let plannedMonthly = ZERO;
    let plannedAnnual = ZERO;
    let activeSchedules = 0;
    for (const h of holdings) {
      if (!h.sipActive || !h.monthlyContribution || !h.contributionStartDate) continue;
      if (h.contributionEndDate && h.contributionEndDate.getTime() < now.getTime()) continue;
      const cadence = ((h.contributionFrequency as CadenceName | null) ?? "MONTHLY") as CadenceName;
      const amount = toDecimal(h.monthlyContribution);
      plannedMonthly = plannedMonthly.plus(monthlyEquivalent(amount, cadence));
      plannedAnnual = plannedAnnual.plus(annualContribution(amount, cadence));
      activeSchedules += 1;
    }

    // Allocation of the CURRENT recorded value, three ways. Percentages are of the total value (1 dp).
    const total = holdings.reduce((sum, h) => sum.plus(toDecimal(h.currentValue)), ZERO);
    const group = (key: (h: (typeof holdings)[number]) => string) => {
      const sums = new Map<string, Prisma.Decimal>();
      for (const h of holdings) sums.set(key(h), (sums.get(key(h)) ?? ZERO).plus(toDecimal(h.currentValue)));
      return [...sums.entries()]
        .sort((a, b) => b[1].comparedTo(a[1]))
        .map(([k, value]) => {
          const pct = percentOf(value, total);
          return { key: k, value: toMoneyString(value), percent: pct === null ? 0 : Number(pct.toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString()) };
        });
    };

    return {
      basis: "ACTUAL",
      months,
      contributionTrend: series.contributionTrend.map((r) => ({
        month: r.month,
        contributions: toMoneyString(r.contributions),
        employer: toMoneyString(r.employer),
        withdrawals: toMoneyString(r.withdrawals),
      })),
      valueTrend: series.valueTrend.map((r) => ({ month: r.month, value: r.value ? toMoneyString(r.value) : null, holdingsValued: r.holdingsValued })),
      gainTrend: series.gainTrend.map((r) => ({ month: r.month, gain: r.gain ? toMoneyString(r.gain) : null, coveredHoldings: r.coveredHoldings })),
      allocation: {
        totalValue: toMoneyString(total),
        byType: group((h) => h.type),
        byRisk: group((h) => h.riskLevel),
        byLiquidity: group((h) => h.liquidity),
      },
      overview: {
        holdings: holdings.length,
        holdingsWithLedger: series.holdingsWithLedger,
        activeSchedules,
        plannedMonthlyContribution: toMoneyString(plannedMonthly),
        plannedAnnualContribution: toMoneyString(plannedAnnual),
        actualContributionsThisMonth: toMoneyString(series.contributionsThisMonth),
        actualContributionsThisYear: toMoneyString(series.contributionsThisYear),
      },
    };
  }
}
