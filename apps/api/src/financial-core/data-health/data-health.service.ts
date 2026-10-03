import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { FinancialFactsService } from "../../common/financial-facts/financial-facts.service";
import {
  ContributionRow,
  DataHealthIssue,
  ExpenseRow,
  IncomeRow,
  InvestmentRow,
  detectDuplicateRecurringEvents,
  detectDuplicateSalary,
  detectExpenseDuplicates,
  detectInsuranceIssues,
  detectInvestmentIssues,
  detectLegacySavingsExpenses,
  detectNegativeCash,
} from "./data-health.detectors";

export interface DataHealthReport {
  basis: "ACTUAL";
  asOfDate: string;
  status: "HEALTHY" | "NEEDS_REVIEW";
  issues: DataHealthIssue[];
  // Human-readable checklist for the dashboard card and for the AI Coach to consume.
  checks: Array<{ label: string; ok: boolean }>;
  notChecked: string[];
}

const LOOKBACK_MONTHS = 12;

// Reads the caller's records (always scoped by userId), runs the pure detectors, and
// returns FLAGS only. It never modifies or deletes a financial record.
@Injectable()
export class DataHealthService {
  constructor(
    private prisma: PrismaService,
    private facts: FinancialFactsService,
  ) {}

  async getReport(userId: string): Promise<DataHealthReport> {
    const db = this.prisma.client;
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - LOOKBACK_MONTHS, 1));

    const [incomes, expenses, contributions, policies, investments, cashflowRefs, entryRefs, position] = await Promise.all([
      db.income.findMany({
        where: { userId, receivedAt: { gte: since } },
        select: { id: true, source: true, amount: true, receivedAt: true, generatedFromRecurringId: true },
      }),
      db.expense.findMany({
        where: { userId, spentAt: { gte: since } },
        select: {
          id: true,
          amount: true,
          spentAt: true,
          merchant: true,
          sourceType: true,
          sourceId: true,
          sourceReference: true,
          category: { select: { name: true, type: true } },
        },
      }),
      db.investmentCashflow.findMany({
        where: { userId, type: "CONTRIBUTION", occurredAt: { gte: since } },
        select: { id: true, investmentId: true, amount: true, occurredAt: true },
      }),
      db.insurancePolicy.findMany({ where: { userId }, select: { id: true, premiumAmount: true } }),
      db.investment.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          costBasis: true,
          valuations: { orderBy: { valuedAt: "desc" }, take: 1, select: { valuedAt: true } },
          cashflows: { select: { type: true, amount: true } },
        },
      }),
      db.investmentCashflow.findMany({ where: { userId, sourceExpenseId: { not: null } }, select: { sourceExpenseId: true } }),
      db.emergencyFundEntry.findMany({ where: { userId, sourceExpenseId: { not: null } }, select: { sourceExpenseId: true } }),
      this.facts.getFinancialPosition(userId),
    ]);

    const migrated = new Set<string>();
    for (const r of cashflowRefs) if (r.sourceExpenseId) migrated.add(r.sourceExpenseId);
    for (const r of entryRefs) if (r.sourceExpenseId) migrated.add(r.sourceExpenseId);

    const incomeRows: IncomeRow[] = incomes.map((i) => ({ ...i, amount: i.amount.toString() }));
    const expenseRows: ExpenseRow[] = expenses.map((e) => ({
      id: e.id,
      amount: e.amount.toString(),
      spentAt: e.spentAt,
      merchant: e.merchant,
      categoryName: e.category.name,
      categoryType: e.category.type,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      sourceReference: e.sourceReference,
      migrated: migrated.has(e.id),
    }));
    const contributionRows: ContributionRow[] = contributions.map((c) => ({ ...c, amount: c.amount.toString() }));
    const investmentRows: InvestmentRow[] = investments.map((i) => {
      let invested = 0;
      let returned = 0;
      for (const c of i.cashflows) {
        const a = Number(c.amount);
        if (c.type === "CONTRIBUTION" || c.type === "EMPLOYER_CONTRIBUTION" || c.type === "TRANSFER_IN") invested += a;
        if (c.type === "WITHDRAWAL" || c.type === "SALE" || c.type === "TRANSFER_OUT") returned += a;
      }
      return {
        id: i.id,
        name: i.name,
        costBasis: i.costBasis.toString(),
        latestValuationAt: i.valuations[0]?.valuedAt ?? null,
        // Only comparable when the user has actually recorded cashflows for it, and only
        // for holdings with no withdrawals/sales (otherwise cost basis legitimately differs).
        netCostFromCashflows: i.cashflows.length > 0 && returned === 0 ? invested.toFixed(2) : null,
      };
    });

    const issues: DataHealthIssue[] = [
      ...detectDuplicateSalary(incomeRows),
      ...detectDuplicateRecurringEvents(incomeRows),
      ...detectExpenseDuplicates(expenseRows),
      ...detectLegacySavingsExpenses(expenseRows, contributionRows),
      ...detectInsuranceIssues(expenseRows, policies.map((p) => ({ id: p.id, premiumAmount: p.premiumAmount.toString() }))),
      ...detectInvestmentIssues(investmentRows, now),
      ...detectNegativeCash(position.cash.available),
    ];

    const has = (...codes: DataHealthIssue["code"][]) => issues.some((i) => codes.includes(i.code));
    const checks = [
      { label: "Income reconciled", ok: !has("DUPLICATE_SALARY", "DUPLICATE_RECURRING_EVENT") },
      { label: "Expenses reconciled", ok: !has("DUPLICATE_EXPENSE", "POSSIBLE_BANK_DUPLICATE") },
      { label: "SIPs and investments reconciled", ok: !has("INVESTMENT_AS_EXPENSE", "INCONSISTENT_COST_BASIS") },
      { label: "Emergency fund reconciled", ok: !has("EMERGENCY_AS_EXPENSE") },
      { label: "Insurance linked", ok: !has("MISSING_SOURCE_REFERENCE", "DUPLICATE_INSURANCE_PREMIUM") },
      { label: "Investment valuations current", ok: !has("STALE_INVESTMENT_VALUATION", "MISSING_INVESTMENT_VALUATION") },
      { label: "Cash position consistent", ok: !has("NEGATIVE_AVAILABLE_CASH") },
    ];

    return {
      basis: "ACTUAL",
      asOfDate: now.toISOString(),
      status: issues.some((i) => i.severity === "WARNING") ? "NEEDS_REVIEW" : "HEALTHY",
      issues,
      checks,
      // Honest about scope: these spec'd checks need document linking / premium schedules,
      // which are later phases, so they are NOT silently reported as passing.
      notChecked: ["UNLINKED_DOCUMENT", "MISSING_POLICY_PAYMENT"],
    };
  }
}
