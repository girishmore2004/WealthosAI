// PURE — assembles the Money → Goals detail numbers for ONE goal from its ledger entries and facts.
// It is the emergency-fund overview's arithmetic (same shared formulas: percentOf, emergencyRemaining,
// periodsUntil, requiredContribution, periodsToReach, the ledger totals and the 12-month trend) with the
// two generalisations a non-emergency goal needs:
//   * progress is measured against totalFunded = cash set aside + linked investments (the same basis the
//     Goals overview uses), so the two pages agree; for an emergency goal without linked investments this
//     is identical to the old balance-only figure;
//   * the target is simply "an amount" unless the caller passes a months-based one (emergency reserve only).

import { Prisma } from "@wealthos/db";
import type { GoalFundOverviewDTO } from "@wealthos/types";
import { emergencyRemaining, percentOf, periodsToReach, periodsUntil, requiredContribution, toMoneyString } from "../../common/financial-facts/financial-formulas";
import { currentMonthString, monthsBefore } from "../../common/utils/financial-period.util";
import { buildTrend, summarizeLedger, LedgerEntryInput } from "../emergency-fund/emergency-fund.util";

const DAYS_PER_MONTH = 30.4375;
const TREND_MONTHS = 12;

type Dec = Prisma.Decimal;

const pct1 = (d: Dec | null): number | null => (d === null ? null : Number(d.toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString()));
const money = (d: Dec | null) => (d === null ? null : toMoneyString(d));

export interface FundOverviewInput {
  entries: LedgerEntryInput[];
  cashBalance: Dec;
  linkedInvestmentValue: Dec;
  target: { mode: "AMOUNT" | "MONTHS" | null; amount: Dec | null; months: Dec | null; needsExpenseHistory: boolean };
  plan: { monthlyContribution: Dec | null; targetDate: Date | null };
  now: Date;
}

export type FundOverviewCore = Pick<GoalFundOverviewDTO, "basis" | "currency" | "balance" | "target" | "progress" | "plan" | "totals" | "last" | "trend" | "entryCount"> & {
  totalFunded: string;
};

export function buildFundOverview(i: FundOverviewInput): FundOverviewCore {
  const currentMonth = currentMonthString(i.now);
  const totals = summarizeLedger(i.entries, currentMonth);
  const totalFunded = i.cashBalance.plus(i.linkedInvestmentValue);

  const targetAmount = i.target.amount;
  const remaining = targetAmount ? emergencyRemaining(targetAmount, totalFunded) : null;
  const reached = targetAmount ? totalFunded.gte(targetAmount) : false;
  const progress = targetAmount ? percentOf(totalFunded, targetAmount) : null;

  const targetDate = i.plan.targetDate;
  const monthsLeft = targetDate ? periodsUntil(targetDate, i.now, DAYS_PER_MONTH) : null;
  const weeksLeft = targetDate ? periodsUntil(targetDate, i.now, 7) : null;
  const requiredMonthly = remaining && monthsLeft !== null ? requiredContribution(remaining, monthsLeft) : null;
  const requiredWeekly = remaining && weeksLeft !== null ? requiredContribution(remaining, weeksLeft) : null;
  const planned = i.plan.monthlyContribution;
  const monthsToTarget = remaining && planned ? periodsToReach(remaining, planned) : null;
  const estimatedFinish =
    monthsToTarget !== null && monthsToTarget > 0 ? new Date(i.now.getTime() + monthsToTarget * DAYS_PER_MONTH * 86_400_000).toISOString() : null;

  const months = Array.from({ length: TREND_MONTHS }, (_, k) => monthsBefore(currentMonth, TREND_MONTHS - 1 - k));
  const trend = buildTrend(i.entries, months);
  const point = (p: { occurredAt: Date; amount: Dec } | null) => (p ? { date: p.occurredAt.toISOString(), amount: toMoneyString(p.amount) } : null);

  return {
    basis: "ACTUAL",
    currency: "INR",
    balance: toMoneyString(i.cashBalance),
    totalFunded: toMoneyString(totalFunded),
    target: {
      basis: "TARGET",
      mode: i.target.mode,
      amount: money(targetAmount),
      months: i.target.months ? i.target.months.toString() : null,
      needsExpenseHistory: i.target.needsExpenseHistory,
    },
    progress: { percent: pct1(progress), remaining: money(remaining), reached },
    plan: {
      basis: "ESTIMATED",
      monthlyContribution: money(planned),
      targetDate: targetDate ? targetDate.toISOString() : null,
      requiredMonthly: money(requiredMonthly),
      requiredWeekly: money(requiredWeekly),
      monthsToTargetAtPlan: monthsToTarget,
      estimatedFinishDate: estimatedFinish,
    },
    totals: {
      contributions: toMoneyString(totals.contributions),
      withdrawals: toMoneyString(totals.withdrawals),
      adjustments: toMoneyString(totals.adjustments),
      contributedThisMonth: toMoneyString(totals.contributionsThisMonth),
      contributedThisYear: toMoneyString(totals.contributionsThisYear),
      withdrawnThisYear: toMoneyString(totals.withdrawalsThisYear),
    },
    last: { contribution: point(totals.lastContribution), withdrawal: point(totals.lastWithdrawal) },
    trend: trend.map((t) => ({ month: t.month, closingBalance: toMoneyString(t.closingBalance), added: toMoneyString(t.added), used: toMoneyString(t.used) })),
    entryCount: i.entries.length,
  };
}
