import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LoansService } from "../loans/loans.service";
import { InsuranceService } from "../insurance/insurance.service";
import { GoalsService } from "../goals/goals.service";
import { ExpensesService } from "../expenses/expenses.service";
import { BusinessService } from "../business/business.service";
import { DocumentsService } from "../documents/documents.service";
import { AlertSeverity, AlertType } from "@wealthos/db";

interface AlertCandidate {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  dedupeKey: string;
  dueDate?: Date;
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

  // Re-runs every rule and upserts alerts by dedupeKey, so calling this repeatedly
  // (e.g. on dashboard load) never creates duplicates and naturally clears alerts whose
  // underlying condition no longer holds (those rows are pruned at the end).
  async refresh(userId: string) {
    const candidates: AlertCandidate[] = [];
    const now = new Date();

    const [renewals, loans, debtSummary, goals, subscriptions, breakdown, expiringDocs, obligations] =
      await Promise.all([
        this.insuranceService.upcomingRenewals(userId, 30),
        this.loansService.list(userId),
        this.loansService.debtSummary(userId),
        this.goalsService.list(userId),
        this.expensesService.detectSubscriptions(userId),
        this.expensesService.categoryBreakdown(userId),
        this.documentsService.expiringSoon(userId, 30),
        this.businessService.upcomingObligationsForUser(userId, 14),
      ]);

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
      let nextDue = new Date(now.getFullYear(), now.getMonth(), dueDay);
      if (nextDue < now) nextDue = new Date(now.getFullYear(), now.getMonth() + 1, dueDay);
      const daysUntilDue = Math.ceil((nextDue.getTime() - now.getTime()) / (24 * 3600 * 1000));
      if (daysUntilDue <= 7) {
        candidates.push({
          type: "EMI_DUE",
          severity: "INFO",
          title: `${loan.lender} EMI due soon`,
          message: `₹${Number(loan.emiAmount).toLocaleString("en-IN")} due ${nextDue.toLocaleDateString("en-IN")}.`,
          dedupeKey: `emi-due-${loan.id}-${nextDue.getFullYear()}-${nextDue.getMonth()}`,
          dueDate: nextDue,
        });
      }
    }

    if (debtSummary.debtStressScore > 40) {
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

    const wantOverspend = breakdown.find((b) => b.type === "WANT" && b.total > 15000);
    if (wantOverspend) {
      candidates.push({
        type: "BUDGET_OVERSPEND",
        severity: "WARNING",
        title: `${wantOverspend.name} spending is elevated this month`,
        message: `₹${wantOverspend.total.toLocaleString("en-IN")} spent in ${wantOverspend.name} so far this month.`,
        dedupeKey: `budget-overspend-${wantOverspend.categoryId}-${now.getFullYear()}-${now.getMonth()}`,
      });
    }

    for (const doc of expiringDocs) {
      candidates.push({
        type: "DOCUMENT_EXPIRY",
        severity: "WARNING",
        title: `${doc.fileName} is expiring soon`,
        message: `This ${doc.category.toLowerCase().replace(/_/g, " ")} document expires ${doc.expiryDate!.toLocaleDateString("en-IN")}.`,
        dedupeKey: `document-expiry-${doc.id}`,
        dueDate: doc.expiryDate!,
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

    for (const c of candidates) {
      await this.prisma.client.alert.upsert({
        where: { userId_dedupeKey: { userId, dedupeKey: c.dedupeKey } },
        create: { ...c, userId },
        update: { title: c.title, message: c.message, severity: c.severity, dueDate: c.dueDate },
      });
    }

    // Prune alerts whose dedupeKey no longer matches an active condition (excluding
    // ones the user already read, so acknowledged history isn't silently deleted).
    const activeDedupeKeys = candidates.map((c) => c.dedupeKey);
    await this.prisma.client.alert.deleteMany({
      where: { userId, isRead: false, dedupeKey: { notIn: activeDedupeKeys } },
    });

    return this.list(userId);
  }
}
