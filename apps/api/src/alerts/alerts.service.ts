import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LoansService } from "../loans/loans.service";
import { InsuranceService } from "../insurance/insurance.service";
import { GoalsService } from "../goals/goals.service";
import { ExpensesService } from "../expenses/expenses.service";
import { BusinessService } from "../business/business.service";
import { DocumentsService } from "../documents/documents.service";
import { IncomeService } from "../income/income.service";
import { AlertSeverity, AlertType } from "@wealthos/db";

interface AlertCandidate {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  dedupeKey: string;
  dueDate?: Date;
}

// BUDGET_OVERSPEND was previously a single hardcoded ₹15,000 absolute rupee figure —
// the audit correctly flagged this as meaning very different things for a ₹40k/month
// earner vs. a ₹4L/month earner. Now expressed as a percentage of the user's own
// IncomeService.monthlyForecast(), consistent with how DEBT_STRESS's threshold and
// DashboardService's own WANT-overspend insight are already expressed as percentages
// of income rather than fixed rupee amounts.
const OVERSPEND_WARNING_PERCENT_OF_INCOME = 0.2; // 20% of monthly income in a single WANT category
const OVERSPEND_CRITICAL_PERCENT_OF_INCOME = 0.3; // 30%+ escalates to CRITICAL, mirroring DEBT_STRESS's two-tier severity
// Fallback for users with no income logged yet (monthlyForecast() === 0), so the rule
// doesn't simply go silent for them — preserves the previous fixed-threshold behavior
// as a floor rather than replacing it outright.
const OVERSPEND_FALLBACK_WARNING_THRESHOLD = 15000;
const OVERSPEND_FALLBACK_CRITICAL_THRESHOLD = 22500;

// Days-until-due at or below which EMI_DUE escalates from INFO to WARNING — new
// severity tiering, mirroring the WARNING/CRITICAL pattern already used elsewhere in
// this file (DEBT_STRESS, GOAL_DELAY) so "due very soon" reads as more urgent than
// "due sometime in the next week."
const EMI_DUE_WARNING_WITHIN_DAYS = 2;

// Clamps `day` to the last real day of the target month when it overflows (e.g. a loan
// started on the 31st, evaluated against a 30- or 28/29-day month). JS's
// `new Date(year, month, day)` silently rolls an out-of-range day into the *next*
// month (e.g. `new Date(2026, 3, 31)` becomes May 1, not April 30) — previously this
// could push an EMI's "next due" date a full month off from what the user actually
// agreed to pay on.
function dateForDayInMonth(year: number, month: number, day: number): Date {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, daysInMonth));
}

// A deterministic, rules-based alerts engine — every alert here traces to a concrete
// threshold on the user's own data (renewal dates, EMI schedules, goal math, spend
// deltas). No ML/LLM involved, intentionally, so every alert is explainable.
@Injectable()
export class AlertsService {
  constructor(
    private prisma: PrismaService,
    private loansService: LoansService,
    private insuranceService: InsuranceService,
    private goalsService: GoalsService,
    private expensesService: ExpensesService,
    private businessService: BusinessService,
    private documentsService: DocumentsService,
    private incomeService: IncomeService,
  ) {}

  async list(userId: string, unreadOnly = false) {
    return this.prisma.client.alert.findMany({
      where: { userId, ...(unreadOnly ? { isRead: false } : {}) },
      orderBy: [{ isRead: "asc" }, { createdAt: "desc" }],
    });
  }

  async markRead(userId: string, id: string) {
    return this.prisma.client.alert.updateMany({ where: { id, userId }, data: { isRead: true } });
  }

  async dismiss(userId: string, id: string) {
    return this.prisma.client.alert.deleteMany({ where: { id, userId } });
  }

  // Used by refresh() to degrade gracefully: each of the 8 rules' data source is
  // independent of the others, so one upstream failure (e.g. a malformed record in a
  // single unrelated feature) should skip just that rule, not fail the entire refresh.
  // Alerts is surfaced inline on every dashboard load (DashboardService awaits
  // refresh()), so an all-or-nothing failure here would previously have been able to
  // silently take down the whole Dashboard too.
  private settled<T>(result: PromiseSettledResult<T>, fallback: T, ruleLabel: string): T {
    if (result.status === "fulfilled") return result.value;
    // eslint-disable-next-line no-console
    console.error(`[AlertsService] data source for "${ruleLabel}" failed — skipping that rule for this refresh.`, result.reason);
    return fallback;
  }

  // Re-runs every rule and upserts alerts by dedupeKey, so calling this repeatedly
  // (e.g. on dashboard load) never creates duplicates and naturally clears alerts whose
  // underlying condition no longer holds (those rows are pruned at the end).
  async refresh(userId: string) {
    const candidates: AlertCandidate[] = [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const results = await Promise.allSettled([
      this.insuranceService.upcomingRenewals(userId, 30),
      this.loansService.list(userId),
      this.loansService.debtSummary(userId),
      this.goalsService.list(userId),
      this.expensesService.detectSubscriptions(userId),
      this.expensesService.categoryBreakdown(userId),
      this.documentsService.expiringSoon(userId, 30),
      this.businessService.upcomingObligationsForUser(userId, 14),
      this.incomeService.monthlyForecast(userId),
    ]);

    const [
      renewalsResult,
      loansResult,
      debtSummaryResult,
      goalsResult,
      subscriptionsResult,
      breakdownResult,
      expiringDocsResult,
      obligationsResult,
      monthlyIncomeResult,
    ] = results;

    const renewals = this.settled(renewalsResult, [], "INSURANCE_RENEWAL");
    const loans = this.settled(loansResult, [], "EMI_DUE");
    const debtSummary = this.settled(debtSummaryResult, null, "DEBT_STRESS");
    const goals = this.settled(goalsResult, [], "GOAL_DELAY");
    const subscriptions = this.settled(subscriptionsResult, [], "SUBSCRIPTION_RENEWAL");
    const breakdown = this.settled(breakdownResult, [], "BUDGET_OVERSPEND");
    const expiringDocs = this.settled(expiringDocsResult, [], "DOCUMENT_EXPIRY");
    const obligations = this.settled(obligationsResult, [], "BUSINESS_OBLIGATION_DUE");
    const monthlyIncome = this.settled(monthlyIncomeResult, 0, "BUDGET_OVERSPEND (income lookup)");

    for (const policy of renewals) {
      candidates.push({
        type: "INSURANCE_RENEWAL",
        severity: "WARNING",
        title: `${policy.provider} ${policy.type.toLowerCase()} policy renews soon`,
        message: `Renewal due ${policy.renewalDate.toLocaleDateString("en-IN")}. Premium: ₹${Number(policy.premiumAmount).toLocaleString("en-IN")}.`,
        dedupeKey: `insurance-renewal-${policy.id}`,
        dueDate: policy.renewalDate,
      });
    }

    for (const loan of loans) {
      const dueDay = loan.startDate.getDate();
      let nextDue = dateForDayInMonth(now.getFullYear(), now.getMonth(), dueDay);
      // Both sides are midnight-normalized before comparing. The previous version
      // compared `nextDue` (always midnight) against `now` (still carrying a
      // time-of-day) — on the due date itself, midnight is always "less than" the
      // current moment, so an EMI due *today* was incorrectly rolled forward a full
      // month and never surfaced a "due today" alert.
      if (nextDue < today) {
        nextDue = dateForDayInMonth(now.getFullYear(), now.getMonth() + 1, dueDay);
      }
      const daysUntilDue = Math.round((nextDue.getTime() - today.getTime()) / (24 * 3600 * 1000));
      if (daysUntilDue <= 7) {
        candidates.push({
          type: "EMI_DUE",
          severity: daysUntilDue <= EMI_DUE_WARNING_WITHIN_DAYS ? "WARNING" : "INFO",
          title: `${loan.lender} EMI due soon`,
          message: `₹${Number(loan.emiAmount).toLocaleString("en-IN")} due ${nextDue.toLocaleDateString("en-IN")}.`,
          dedupeKey: `emi-due-${loan.id}-${nextDue.getFullYear()}-${nextDue.getMonth()}`,
          dueDate: nextDue,
        });
      }
    }

    if (debtSummary && debtSummary.debtStressScore > 40) {
      candidates.push({
        type: "DEBT_STRESS",
        severity: debtSummary.debtStressScore > 60 ? "CRITICAL" : "WARNING",
        title: "EMI load is high relative to income",
        message: `Total EMIs are ${debtSummary.debtStressScore}% of monthly income, based on current loans and income logged.`,
        dedupeKey: "debt-stress",
      });
    }

    for (const goal of goals) {
      if (goal.probabilityOfSuccess !== "ON_TRACK") {
        candidates.push({
          type: "GOAL_DELAY",
          severity: goal.probabilityOfSuccess === "OFF_TRACK" ? "CRITICAL" : "WARNING",
          title: `"${goal.name}" goal may be delayed`,
          message: `Current contribution is below the ₹${Number(goal.requiredMonthlyContribution).toLocaleString("en-IN")}/month needed to reach this goal by its target date.`,
          dedupeKey: `goal-delay-${goal.id}`,
        });
      }
    }

    for (const sub of subscriptions) {
      candidates.push({
        type: "SUBSCRIPTION_RENEWAL",
        severity: "INFO",
        title: `Recurring charge detected: ${sub.merchant}`,
        message: `Seen ${sub.occurrences} times recently, averaging ₹${sub.averageAmount.toFixed(0)}. Review if still needed.`,
        dedupeKey: `subscription-${sub.merchant}`,
      });
    }

    // Income-relative overspend threshold (see constants above), with an absolute-₹
    // fallback for users with no income logged. Previously `.find()` meant only ever
    // one over-threshold WANT category could ever produce an alert in a single refresh
    // — changed to `.filter()` so a user overspending across several WANT categories
    // sees all of them (each already has a distinct dedupeKey via categoryId, so this
    // was always structurally supported, just never exercised).
    const warningThreshold =
      monthlyIncome > 0 ? monthlyIncome * OVERSPEND_WARNING_PERCENT_OF_INCOME : OVERSPEND_FALLBACK_WARNING_THRESHOLD;
    const criticalThreshold =
      monthlyIncome > 0 ? monthlyIncome * OVERSPEND_CRITICAL_PERCENT_OF_INCOME : OVERSPEND_FALLBACK_CRITICAL_THRESHOLD;

    const overspentWantCategories = breakdown.filter((b) => b.type === "WANT" && b.total > warningThreshold);
    for (const cat of overspentWantCategories) {
      candidates.push({
        type: "BUDGET_OVERSPEND",
        severity: cat.total > criticalThreshold ? "CRITICAL" : "WARNING",
        title: `${cat.name} spending is elevated this month`,
        message:
          monthlyIncome > 0
            ? `₹${cat.total.toLocaleString("en-IN")} spent in ${cat.name} so far this month — over ${Math.round(OVERSPEND_WARNING_PERCENT_OF_INCOME * 100)}% of your monthly income.`
            : `₹${cat.total.toLocaleString("en-IN")} spent in ${cat.name} so far this month.`,
        dedupeKey: `budget-overspend-${cat.categoryId}-${now.getFullYear()}-${now.getMonth()}`,
      });
    }

    for (const doc of expiringDocs) {
      // Defensive: expiringSoon()'s own `where` clause already filters to non-null
      // expiryDate at the DB level, but Prisma's generated TS type still allows
      // `Date | null` here since it can't statically prove that. Guarding explicitly
      // means a contract violation in Documents can't crash Alerts.
      if (!doc.expiryDate) continue;
      candidates.push({
        type: "DOCUMENT_EXPIRY",
        severity: "WARNING",
        title: `${doc.fileName} is expiring soon`,
        message: `This ${doc.category.toLowerCase().replace(/_/g, " ")} document expires ${doc.expiryDate.toLocaleDateString("en-IN")}.`,
        dedupeKey: `document-expiry-${doc.id}`,
        dueDate: doc.expiryDate,
      });
    }

    for (const obligation of obligations) {
      candidates.push({
        type: "BUSINESS_OBLIGATION_DUE",
        severity: "WARNING",
        title: `${obligation.title} due soon (${obligation.business.name})`,
        message: `Due ${obligation.dueDate.toLocaleDateString("en-IN")}${obligation.amount ? ` · ₹${Number(obligation.amount).toLocaleString("en-IN")}` : ""}.`,
        dedupeKey: `business-obligation-${obligation.id}`,
        dueDate: obligation.dueDate,
      });
    }

    // Parallelized: each upsert targets an independent (userId, dedupeKey) row, so
    // there's no ordering dependency between them. The previous sequential
    // `for...await` loop issued one DB round-trip at a time for every candidate.
    await Promise.all(
      candidates.map((c) =>
        this.prisma.client.alert.upsert({
          where: { userId_dedupeKey: { userId, dedupeKey: c.dedupeKey } },
          create: { ...c, userId },
          update: { title: c.title, message: c.message, severity: c.severity, dueDate: c.dueDate },
        }),
      ),
    );

    // Prune alerts whose dedupeKey no longer matches an active condition (excluding
    // ones the user already read, so acknowledged history isn't silently deleted).
    const activeDedupeKeys = candidates.map((c) => c.dedupeKey);
    await this.prisma.client.alert.deleteMany({
      where: { userId, isRead: false, dedupeKey: { notIn: activeDedupeKeys } },
    });

    return this.list(userId);
  }
}
