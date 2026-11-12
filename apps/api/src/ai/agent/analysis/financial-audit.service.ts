import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { FinancialToolsService } from "../../financial-engine/financial-tools.service";
import { ToolResult } from "../../financial-engine/financial-types";
import { AuditInputs, DiscrepancyRow, ExpenseRow, Fetched, FinancialAudit, buildFinancialAudit, referenceIncome } from "./financial-audit";
import { monthlyEquivalent, round2 } from "./financial-math";
import { SpendingReport, analyzeSpending } from "./spending-intelligence";

const num = (v: { value: string } | undefined): number | null => (v === undefined ? null : Number(v.value));
const dec = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const DAY = 86_400_000;

export interface ScenarioBaselineFigures {
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlySip: number;
  currentInvestmentValue: number;
}

/**
 * Fetches every financial domain for one user in parallel and hands the results to the pure audit builder.
 *
 * All reads are read-only and scoped by `userId` (which only ever comes from the authenticated session). Each domain is
 * fetched independently inside `settle`, so one failing query turns into a "retrieval failed" domain instead of hiding the
 * others, and an unexecuted domain can never be mistaken for an empty one.
 */
@Injectable()
export class FinancialAuditService {
  private readonly logger = new Logger(FinancialAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: FinancialToolsService,
  ) {}

  async collect(userId: string, now: Date = new Date()): Promise<FinancialAudit> {
    const inputs = await this.fetchInputs(userId, now);
    return buildFinancialAudit(inputs);
  }

  /** Spending analysis on its own (no other domains are fetched). */
  async spending(userId: string, now: Date = new Date()): Promise<{ report: SpendingReport | null; error: string | null; duplicates: number }> {
    const [rows, cf] = await Promise.all([this.settle("expenses", () => this.expenseRows(userId, now)), this.settle("cashFlow", () => this.cashFlow(userId))]);
    if (!rows.ok) return { report: null, error: rows.error, duplicates: 0 };
    let income = cf.ok ? cf.data.income : null;
    let incomeNote: string | null = null;
    if (income === null || income <= 0) {
      const inc = await this.settle("income", () => this.incomeRows(userId, now));
      const ref = inc.ok ? referenceIncome(inc.data, income, now) : null;
      if (ref) { income = ref.amount; incomeNote = `Income comparisons use the ${ref.basis}.`; }
    }
    const report = analyzeSpending(rows.data, { now, monthlyIncome: income });
    if (incomeNote) report.limitations.push(incomeNote);
    return { report, error: null, duplicates: 0 };
  }

  async documentConflicts(userId: string): Promise<Fetched<DiscrepancyRow[]>> {
    return this.settle("discrepancies", () => this.discrepancies(userId));
  }

  /**
   * Baseline for what-if projections. Prefers the average of up to three COMPLETE months (a half-finished month would
   * understate spending and distort every scenario); falls back to this month's ledger and says so in `basis`.
   */
  async scenarioBaseline(userId: string, now: Date = new Date()): Promise<{ baseline: ScenarioBaselineFigures; basis: string[] } | { error: string }> {
    const [cf, inc, exp, inv] = await Promise.all([
      this.settle("cashFlow", () => this.cashFlow(userId)),
      this.settle("income", () => this.incomeRows(userId, now)),
      this.settle("expenses", () => this.expenseRows(userId, now)),
      this.settle("investments", () => this.investments(userId, now)),
    ]);
    if (!cf.ok && !inc.ok) return { error: "income could not be retrieved" };
    const basis: string[] = [];
    const key = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const current = key(now);
    let monthlyIncome = cf.ok ? cf.data.income : 0;
    if (inc.ok) {
      const byMonth = new Map<string, number>();
      for (const r of inc.data) if (key(r.receivedAt) !== current) byMonth.set(key(r.receivedAt), (byMonth.get(key(r.receivedAt)) ?? 0) + r.amount);
      const recent = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 3).map((e) => e[1]);
      if (recent.length >= 1) {
        monthlyIncome = round2(recent.reduce((a, b) => a + b, 0) / recent.length);
        basis.push(`income: average of the last ${recent.length} complete month(s)`);
      }
    }
    if (basis.length === 0) basis.push("income: this month's recorded income");
    let monthlyExpenses = cf.ok ? cf.data.expenses : 0;
    if (exp.ok) {
      const r = analyzeSpending(exp.data, { now });
      if (r.averageMonthly !== null) {
        monthlyExpenses = r.averageMonthly;
        basis.push(`expenses: average of ${r.completeMonthsUsed} complete months`);
      } else basis.push("expenses: this month's recorded expenses (fewer than 2 complete months of history)");
    } else basis.push("expenses: this month's recorded expenses");
    let monthlySip = 0;
    let currentInvestmentValue = 0;
    if (inv.ok) {
      for (const i of inv.data) {
        currentInvestmentValue += i.currentValue;
        if (i.sipActive && !i.sipPaused && !i.sipCancelled && (i.monthlyContribution ?? 0) > 0) monthlySip += monthlyEquivalent(i.monthlyContribution ?? 0, i.contributionFrequency) ?? 0;
      }
      basis.push("SIP and investment value: active SIPs and current holdings");
    } else basis.push("SIP and investment value: not retrievable, treated as zero");
    return { baseline: { monthlyIncome, monthlyExpenses, monthlySip: round2(monthlySip), currentInvestmentValue: round2(currentInvestmentValue) }, basis };
  }

  async fetchInputs(userId: string, now: Date): Promise<AuditInputs> {
    const [cashFlow, netWorth, emergency, incomeRows, expenseRows, investments, loans, policies, goals, recurringIncomeCount, dataHealth, discrepancies] = await Promise.all([
      this.settle("cashFlow", () => this.cashFlow(userId)),
      this.settle("netWorth", () => this.netWorth(userId)),
      this.settle("emergency", () => this.emergency(userId)),
      this.settle("income", () => this.incomeRows(userId, now)),
      this.settle("expenses", () => this.expenseRows(userId, now)),
      this.settle("investments", () => this.investments(userId, now)),
      this.settle("loans", () => this.loans(userId)),
      this.settle("insurance", () => this.policies(userId)),
      this.settle("goals", () => this.goals(userId)),
      this.settle("recurringIncome", () => this.prisma.client.income.count({ where: { userId, recurrenceActive: true } })),
      this.settle("dataHealth", () => this.dataHealth(userId)),
      this.settle("discrepancies", () => this.discrepancies(userId)),
    ]);
    return { asOf: now, cashFlow, netWorth, emergency, incomeRows, expenseRows, investments, loans, policies, goals, recurringIncomeCount, dataHealth, discrepancies };
  }

  private async settle<T>(domain: string, fn: () => Promise<T>): Promise<Fetched<T>> {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`audit domain "${domain}" failed: ${message}`);
      return { ok: false, error: message.slice(0, 200) };
    }
  }

  private async cashFlow(userId: string): Promise<NonNullable<Extract<AuditInputs["cashFlow"], { ok: true }>["data"]>> {
    const r: ToolResult = await this.tools.getCashFlow(userId);
    const rate = num(r.facts.savingsRate);
    return {
      income: num(r.facts.income) ?? 0,
      expenses: num(r.facts.expenses) ?? 0,
      investmentContributions: num(r.facts.investmentContributions) ?? 0,
      emergencyAllocations: num(r.facts.emergencyAllocations) ?? 0,
      netCashFlow: num(r.facts.netCashFlow) ?? 0,
      savingsRatePercent: rate === null ? null : round2(rate * 100), // the engine reports a fraction
    };
  }

  private async netWorth(userId: string) {
    const r = await this.tools.getNetWorth(userId);
    return {
      availableCash: num(r.facts.availableCash) ?? 0,
      emergencyCash: num(r.facts.emergencyCash) ?? 0,
      totalCash: num(r.facts.totalCash) ?? 0,
      investmentValue: num(r.facts.investmentValue) ?? 0,
      loans: num(r.facts.loans) ?? 0,
      totalAssets: num(r.facts.totalAssets) ?? 0,
      totalLiabilities: num(r.facts.totalLiabilities) ?? 0,
      netWorth: num(r.facts.netWorth) ?? 0,
    };
  }

  private async emergency(userId: string) {
    const r = await this.tools.getEmergencyFundOverview(userId);
    return { balance: num(r.facts.balance) ?? 0, coverageMonths: num(r.facts.coverageMonths), targetAmount: num(r.facts.targetAmount), avgMonthlyEssentialExpenses: num(r.facts.avgMonthlyEssentialExpenses) };
  }

  private async incomeRows(userId: string, now: Date) {
    const rows = await this.prisma.client.income.findMany({ where: { userId, receivedAt: { gte: new Date(now.getTime() - 366 * DAY) } }, orderBy: { receivedAt: "desc" }, take: 1000 });
    return rows.map((r) => ({ label: r.label, source: String(r.source), amount: dec(r.amount), recurrence: String(r.recurrence), receivedAt: r.receivedAt, recurrenceActive: r.recurrenceActive }));
  }

  // Lifestyle spending only (flowType EXPENSE, not SAVINGS-type categories) — the same definition as the cash-flow ledger, so
  // this month's total here equals the figure the user already sees elsewhere.
  private async expenseRows(userId: string, now: Date): Promise<ExpenseRow[]> {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
    const rows = await this.prisma.client.expense.findMany({
      where: { userId, flowType: "EXPENSE", spentAt: { gte: from, lte: now }, category: { type: { not: "SAVINGS" } } },
      include: { category: { select: { name: true, type: true } } },
      orderBy: { spentAt: "desc" },
      take: 5000,
    });
    return rows.map((r) => ({ id: r.id, date: r.spentAt, amount: dec(r.amount), category: r.category.name, categoryType: r.category.type, merchant: r.merchant, isRecurring: r.isRecurring, paymentMethod: String(r.paymentMethod) }));
  }

  private async investments(userId: string, now: Date) {
    const from = new Date(now.getTime() - 366 * DAY);
    const [rows, flows] = await Promise.all([
      this.prisma.client.investment.findMany({ where: { userId }, orderBy: { currentValue: "desc" }, take: 500 }),
      this.prisma.client.investmentCashflow.groupBy({ by: ["investmentId"], where: { userId, type: "CONTRIBUTION", occurredAt: { gte: from } }, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const byInv = new Map(flows.map((f) => [f.investmentId, { sum: dec(f._sum.amount), count: f._count._all }]));
    return rows.map((i) => ({
      id: i.id,
      name: i.name,
      type: String(i.type),
      currentValue: dec(i.currentValue),
      costBasis: dec(i.costBasis),
      riskLevel: String(i.riskLevel),
      sipActive: i.sipActive,
      sipPaused: i.sipPausedAt !== null,
      sipCancelled: i.sipCancelledAt !== null,
      monthlyContribution: i.monthlyContribution === null ? null : dec(i.monthlyContribution),
      contributionFrequency: String(i.contributionFrequency),
      contributionDay: i.contributionDay,
      contributionStartDate: i.contributionStartDate,
      contributions12m: byInv.get(i.id)?.sum ?? 0,
      contributionCount12m: byInv.get(i.id)?.count ?? 0,
    }));
  }

  private async loans(userId: string) {
    const rows = await this.prisma.client.loan.findMany({ where: { userId }, orderBy: { outstandingPrincipal: "desc" }, take: 100 });
    return rows.map((l) => ({ lender: l.lender, type: String(l.type), principal: dec(l.principal), outstanding: dec(l.outstandingPrincipal), ratePercent: dec(l.interestRateAnnual), tenureMonths: l.tenureMonths, emi: dec(l.emiAmount), startDate: l.startDate }));
  }

  private async policies(userId: string) {
    const [rows, paid] = await Promise.all([
      this.prisma.client.insurancePolicy.findMany({ where: { userId }, orderBy: { renewalDate: "asc" }, take: 100 }),
      this.prisma.client.expense.groupBy({ by: ["sourceId"], where: { userId, sourceType: "INSURANCE_PREMIUM" }, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const byPolicy = new Map(paid.filter((p) => p.sourceId).map((p) => [p.sourceId as string, { sum: dec(p._sum.amount), count: p._count._all }]));
    return rows.map((p) => ({
      id: p.id,
      provider: p.provider,
      type: String(p.type),
      premiumAmount: dec(p.premiumAmount),
      frequency: String(p.premiumFrequency),
      coverage: dec(p.coverageAmount),
      renewalDate: p.renewalDate,
      recordedCount: byPolicy.get(p.id)?.count ?? 0,
      recordedPaid: byPolicy.get(p.id)?.sum ?? 0,
    }));
  }

  private async goals(userId: string) {
    const rows = await this.prisma.client.goal.findMany({ where: { userId }, orderBy: { targetDate: "asc" }, take: 100 });
    return rows.map((g) => ({ name: g.name, type: String(g.type), target: dec(g.targetAmount), current: dec(g.currentAmount), deadline: g.targetDate, monthlyContribution: dec(g.monthlyContribution), archived: g.archivedAt !== null }));
  }

  private async dataHealth(userId: string) {
    const r = await this.tools.getDataHealth(userId);
    return r.warnings.map((w) => ({ code: w.code, severity: w.severity, message: w.message, count: Number((w as { count?: number }).count ?? 0) }));
  }

  private async discrepancies(userId: string) {
    const rows = await this.prisma.client.documentDiscrepancy.findMany({ where: { userId, status: "OPEN" }, include: { document: { select: { fileName: true } } }, orderBy: { createdAt: "desc" }, take: 50 });
    return rows.map((d) => ({ documentName: d.document.fileName, entityType: String(d.entityType), field: d.field, documentValue: d.documentValue, databaseValue: d.databaseValue, status: String(d.status), createdAt: d.createdAt }));
  }
}
