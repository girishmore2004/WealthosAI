import { Injectable } from "@nestjs/common";
import { FinancialFactsService } from "../../common/financial-facts/financial-facts.service";
import { DataHealthService } from "../../financial-core/data-health/data-health.service";
import { InsurancePremiumService } from "../../insurance/insurance-premium.service";
import { LoansService } from "../../loans/loans.service";
import { ExpensesService } from "../../expenses/expenses.service";
import { EmergencyFundService } from "../../financial-core/emergency-fund/emergency-fund.service";
import { InvestmentAnalyticsService } from "../../investments/investment-analytics.service";
import { InvestmentProjectionService } from "../../investments/investment-projection.service";
import { ReceivablesService } from "../../receivables/receivables.service";
import { Prisma } from "@wealthos/db";
import { toDecimal } from "../../common/financial-facts/financial-formulas";
import { calculateScenario } from "./scenario-planner";
import { FactValue, ProjectionParams, ScenarioParams, ToolResult, ToolWarning } from "./financial-types";

const money = (v: string): FactValue => ({ kind: "MONEY", value: v });
const ratio = (v: string): FactValue => ({ kind: "RATIO", value: v });

// The engine's deterministic financial tools. Each one is a thin, user-scoped adapter over
// FinancialFactsService (and, for insurance / loans / data health, the existing domain
// services) that returns labelled facts. None of them calls a language model, and none
// takes a userId from the request — callers pass the authenticated session's id.
@Injectable()
export class FinancialToolsService {
  constructor(
    private facts: FinancialFactsService,
    private dataHealth: DataHealthService,
    private premiums: InsurancePremiumService,
    private loans: LoansService,
    private expenses: ExpensesService,
    private receivables: ReceivablesService,
    private emergency: EmergencyFundService,
    private investmentAnalytics: InvestmentAnalyticsService,
    private projection: InvestmentProjectionService,
  ) {}

  async getCashFlow(userId: string, month?: string): Promise<ToolResult> {
    const cf = await this.facts.getMonthlyCashFlow(userId, month);
    const facts: ToolResult["facts"] = {
      income: money(cf.income),
      expenses: money(cf.expenses),
      investmentContributions: money(cf.investmentContributions),
      emergencyAllocations: money(cf.emergencyAllocations),
      netCashFlow: money(cf.netCashFlow),
      receivablesGiven: money(cf.receivablesGiven),
      receivableRepayments: money(cf.receivableRepayments),
      otherOutflows: money(cf.otherOutflows),
      internalTransfers: money(cf.internalTransfers),
    };
    if (cf.savingsRate !== null) facts.savingsRate = ratio(cf.savingsRate);
    if (cf.investmentRate !== null) facts.investmentRate = ratio(cf.investmentRate);
    if (cf.expenseRate !== null) facts.expenseRate = ratio(cf.expenseRate);
    return {
      tool: "getCashFlow",
      basis: cf.basis,
      period: cf.period,
      asOfDate: cf.asOfDate,
      facts,
      warnings: cf.dataHealth,
      missing: cf.savingsRate === null ? ["rates (no income recorded this month)"] : [],
    };
  }

  async getNetWorth(userId: string): Promise<ToolResult> {
    const p = await this.facts.getFinancialPosition(userId);
    return {
      tool: "getNetWorth",
      basis: p.basis,
      period: p.period,
      asOfDate: p.asOfDate,
      facts: {
        availableCash: money(p.cash.available),
        emergencyCash: money(p.cash.emergency),
        totalCash: money(p.cash.total),
        investmentValue: money(p.investmentValue),
        property: money(p.property),
        loans: money(p.loans),
        receivables: money(p.receivables.outstanding),
        totalAssets: money(p.totalAssets),
        totalLiabilities: money(p.totalLiabilities),
        netWorth: money(p.netWorth),
      },
      warnings: p.dataHealth,
      missing: [],
    };
  }

  /** Position (lifetime) and this month's cash flow together — the full authoritative snapshot. */
  async getFinancialFacts(userId: string, month?: string): Promise<ToolResult[]> {
    return Promise.all([this.getNetWorth(userId), this.getCashFlow(userId, month)]);
  }

  async getInvestmentSummary(userId: string): Promise<ToolResult> {
    const [p, cf, inv] = await Promise.all([
      this.facts.getFinancialPosition(userId),
      this.facts.getMonthlyCashFlow(userId),
      this.investmentAnalytics.analytics(userId, 1),
    ]);
    return {
      tool: "getInvestmentSummary",
      basis: "ACTUAL",
      period: "LIFETIME",
      asOfDate: p.asOfDate,
      facts: {
        investmentValue: money(p.investmentValue),
        lifetimeContributions: money(p.investmentContributions),
        lifetimeWithdrawals: money(p.investmentWithdrawals),
        monthContributions: money(cf.investmentContributions),
        yearContributions: money(inv.overview.actualContributionsThisYear),
        plannedMonthlyContribution: money(inv.overview.plannedMonthlyContribution),
      },
      warnings: p.dataHealth,
      missing: [],
    };
  }

  async calculateEmergencyCoverage(userId: string): Promise<ToolResult> {
    const c = await this.facts.getEmergencyCoverage(userId);
    const facts: ToolResult["facts"] = {
      emergencyCash: money(c.emergencyCash),
      avgMonthlyEssentialExpenses: money(c.avgMonthlyEssentialExpenses),
    };
    if (c.coverageMonths !== null) facts.coverageMonths = { kind: "MONTHS", value: c.coverageMonths };
    return {
      tool: "calculateEmergencyCoverage",
      basis: c.basis,
      period: c.period,
      asOfDate: c.asOfDate,
      facts,
      warnings: [],
      missing: c.coverageMonths === null ? ["coverage (no essential expenses in recent complete months)"] : [],
    };
  }

  // Receivables: money lent to others. An asset, never an expense. Amounts are the same ones the
  // Receivables page and the dashboard show (ReceivablesService.summary()).
  async getReceivablesSummary(userId: string): Promise<ToolResult> {
    const [sum, pos] = await Promise.all([this.receivables.summary(userId), this.facts.getFinancialPosition(userId)]);
    const facts: ToolResult["facts"] = {
      outstanding: money(sum.totalOutstanding),
      activeCount: { kind: "COUNT", value: String(sum.activeCount) },
      dueSoonAmount: money(sum.dueSoon.amount),
      dueSoonCount: { kind: "COUNT", value: String(sum.dueSoon.count) },
      overdueAmount: money(sum.overdue.amount),
      overdueCount: { kind: "COUNT", value: String(sum.overdue.count) },
      returnedThisMonth: money(sum.returnedThisMonth),
      lifetimeGiven: money(pos.receivables.given),
      lifetimeReturned: money(pos.receivables.returned),
    };
    return { tool: "getReceivablesSummary", basis: "ACTUAL", period: "LIFETIME", asOfDate: pos.asOfDate, facts, warnings: [], missing: [] };
  }

  // Emergency fund: balance, target and progress (TARGET), plus coverage. Reads the same overview the
  // Emergency Fund page shows.
  async getEmergencyFundOverview(userId: string): Promise<ToolResult> {
    const o = await this.emergency.overview(userId);
    const facts: ToolResult["facts"] = {
      balance: money(o.balance),
      avgMonthlyEssentialExpenses: money(o.coverage.avgMonthlyEssentialExpenses),
      contributedThisMonth: money(o.totals.contributedThisMonth),
      contributedThisYear: money(o.totals.contributedThisYear),
    };
    const missing: string[] = [];
    if (o.coverage.months !== null) facts.coverageMonths = { kind: "MONTHS", value: o.coverage.months };
    else missing.push("coverage (no essential expenses in recent complete months)");
    if (o.target.amount !== null) {
      facts.targetAmount = money(o.target.amount);
      if (o.progress.remaining !== null) facts.remaining = money(o.progress.remaining);
      if (o.progress.percent !== null) facts.progress = ratio(String(o.progress.percent / 100));
    } else {
      missing.push("a target (none is set)");
    }
    return { tool: "getEmergencyFundOverview", basis: "ACTUAL", period: "LIFETIME", asOfDate: new Date().toISOString(), facts, warnings: [], missing };
  }

  // This month's expense detail from the analytics endpoint's own numbers: average per day, the top
  // category, its change against the previous month, essential vs discretionary, the largest expense.
  async getExpenseBreakdown(userId: string, now: Date = new Date()): Promise<ToolResult> {
    const today = now.toISOString().slice(0, 10);
    const a = await this.expenses.analytics(userId, { period: "THIS_MONTH", today });
    const sumType = (type: string) =>
      a.categories.filter((c) => c.type === type).reduce((acc, c) => acc.plus(toDecimal(c.total)), new Prisma.Decimal(0));
    const facts: ToolResult["facts"] = {
      monthExpenses: money(a.totals.total),
      averagePerDay: money(a.totals.averagePerDay),
      transactionCount: { kind: "COUNT", value: String(a.totals.transactionCount) },
      essential: money(sumType("NEED").toFixed(2)),
      discretionary: money(sumType("WANT").toFixed(2)),
      previousMonthExpenses: money(a.comparison.total),
    };
    const rows: NonNullable<ToolResult["rows"]> = [];
    const missing: string[] = [];
    const top = [...a.categories].sort((x, y) => toDecimal(y.total).comparedTo(toDecimal(x.total)))[0];
    if (top && toDecimal(top.total).greaterThan(0)) {
      const f: Record<string, FactValue> = { total: money(top.total), previousTotal: money(top.previousTotal) };
      if (top.sharePercent !== null) f.share = ratio(String(top.sharePercent / 100));
      if (top.changePercent !== null) f.change = ratio(String(top.changePercent / 100));
      rows.push({ label: top.name, facts: f });
    } else missing.push("a top category (no spending recorded this month)");
    if (a.totals.largest) facts.largestExpense = money(a.totals.largest.amount);
    if (a.comparison.changePercent !== null) facts.monthChange = ratio(String(a.comparison.changePercent / 100));
    return { tool: "getExpenseBreakdown", basis: "ACTUAL", period: "MONTHLY", asOfDate: now.toISOString(), facts, rows, warnings: [], missing };
  }

  // Year-to-date spending and own investment contributions (ACTUAL, YEARLY).
  async getYearToDate(userId: string, now: Date = new Date()): Promise<ToolResult> {
    const today = now.toISOString().slice(0, 10);
    const [totals, inv] = await Promise.all([this.expenses.periodTotals(userId, today), this.investmentAnalytics.analytics(userId, 1, now)]);
    return {
      tool: "getYearToDate",
      basis: "ACTUAL",
      period: "YEARLY",
      asOfDate: now.toISOString(),
      facts: { yearExpenses: money(totals.year), yearInvested: money(inv.overview.actualContributionsThisYear) },
      warnings: [],
      missing: [],
    };
  }

  // "What will my SIP / portfolio become in N years" - a PROJECTION built by the same deterministic
  // formula as the Investments page, from the recorded values and schedules. Never an actual.
  async projectPortfolio(userId: string, params: ProjectionParams): Promise<ToolResult> {
    const p = await this.projection.portfolio(userId, {
      years: [params.years],
      ...(params.annualReturn !== null ? { annualReturn: Number(params.annualReturn) } : {}),
    });
    const sc = p.scenarios[0];
    const facts: ToolResult["facts"] = {
      valueToday: money(p.includedValueToday),
      years: { kind: "COUNT", value: String(params.years) },
    };
    const missing: string[] = [];
    if (sc && p.includedCount > 0) {
      facts.totalContributions = money(sc.totalContributions);
      facts.principal = money(sc.principal);
      facts.projectedValue = money(sc.projectedValue);
      facts.projectedGain = money(sc.projectedGain);
    } else {
      missing.push("an expected rate of return (name one in your question) or investments with an expected return set");
    }
    const warnings: ToolWarning[] = [{ code: "PROJECTION_NOTE", severity: "INFO", message: p.disclaimer, count: 1 }];
    return { tool: "projectPortfolio", basis: "PROJECTED", period: "CUSTOM", asOfDate: new Date().toISOString(), facts, warnings, missing };
  }

  async getInsuranceSummary(userId: string): Promise<ToolResult> {
    const rows = await this.premiums.totals(userId);
    const total = rows.reduce((s, r) => s + Number(r.totalPaid), 0);
    return {
      tool: "getInsuranceSummary",
      basis: "ACTUAL",
      period: "LIFETIME",
      asOfDate: new Date().toISOString(),
      facts: { policyCount: { kind: "COUNT", value: String(rows.length) }, totalPremiumsRecorded: money(total.toFixed(2)) },
      rows: rows.map((r) => ({ label: `${r.provider} ${String(r.type).toLowerCase().replace(/_/g, " ")}`, facts: { premium: money(r.premiumAmount) } })),
      warnings: [],
      missing: [],
    };
  }

  async getLoanSummary(userId: string): Promise<ToolResult> {
    const d = await this.loans.debtSummary(userId);
    const facts: ToolResult["facts"] = { outstanding: money(Number(d.totalOutstanding).toFixed(2)), monthlyEmi: money(Number(d.totalMonthlyEmi).toFixed(2)) };
    // debtStressScore is already a percent of monthly income (58.3 => 58.3%); convert to a ratio once.
    if (Number(d.totalMonthlyEmi) > 0) facts.debtToIncome = ratio((Number(d.debtStressScore) / 100).toString());
    return { tool: "getLoanSummary", basis: "ACTUAL", period: "LIFETIME", asOfDate: new Date().toISOString(), facts, warnings: [], missing: [] };
  }

  /**
   * Hypothetical what-if over this month's ACTUAL figures. Reads only; returns a PROJECTED
   * result and never writes — the user's real SIP, income and expenses are not touched.
   * Returns null when the question named no amount/percentage or an unsupported scenario.
   */
  async calculateScenario(userId: string, params: ScenarioParams): Promise<ToolResult | null> {
    const cf = await this.facts.getMonthlyCashFlow(userId);
    const outcome = calculateScenario(
      {
        income: cf.income,
        expenses: cf.expenses,
        investmentContributions: cf.investmentContributions,
        emergencyAllocations: cf.emergencyAllocations,
      },
      params,
    );
    if (!outcome) return null;
    const warnings: ToolWarning[] = [
      ...outcome.notes.map((message) => ({ code: "SCENARIO_NOTE", severity: "INFO" as const, message, count: 1 })),
      ...outcome.warnings.map((message) => ({ code: "SCENARIO_NOTE", severity: "WARNING" as const, message, count: 1 })),
    ];
    return {
      tool: "calculateScenario",
      basis: "PROJECTED",
      period: "MONTHLY",
      asOfDate: cf.asOfDate,
      facts: outcome.facts,
      warnings: [...warnings, ...cf.dataHealth],
      missing: [],
    };
  }

  async getDataHealth(userId: string): Promise<ToolResult> {
    const report = await this.dataHealth.getReport(userId);
    return {
      tool: "getDataHealth",
      basis: "ACTUAL",
      period: "CUSTOM",
      asOfDate: report.asOfDate,
      facts: {},
      warnings: report.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message, count: i.count, amount: i.amount })),
      missing: [],
    };
  }
}
