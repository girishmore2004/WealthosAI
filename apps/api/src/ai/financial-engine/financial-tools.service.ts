import { Injectable } from "@nestjs/common";
import { FinancialFactsService } from "../../common/financial-facts/financial-facts.service";
import { DataHealthService } from "../../financial-core/data-health/data-health.service";
import { InsurancePremiumService } from "../../insurance/insurance-premium.service";
import { LoansService } from "../../loans/loans.service";
import { calculateScenario } from "./scenario-planner";
import { FactValue, ScenarioParams, ToolResult, ToolWarning } from "./financial-types";

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
  ) {}

  async getCashFlow(userId: string, month?: string): Promise<ToolResult> {
    const cf = await this.facts.getMonthlyCashFlow(userId, month);
    const facts: ToolResult["facts"] = {
      income: money(cf.income),
      expenses: money(cf.expenses),
      investmentContributions: money(cf.investmentContributions),
      emergencyAllocations: money(cf.emergencyAllocations),
      netCashFlow: money(cf.netCashFlow),
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
    const [p, cf] = await Promise.all([this.facts.getFinancialPosition(userId), this.facts.getMonthlyCashFlow(userId)]);
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
