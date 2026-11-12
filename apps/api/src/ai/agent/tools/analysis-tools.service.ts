import { Injectable, OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { AGENT_SLOW_TOOL_TIMEOUT_MS } from "../agent.constants";
import { FinancialAuditService } from "../analysis/financial-audit.service";
import { formatMoney } from "../analysis/financial-verification";
import { buildImprovementPlan } from "../analysis/improvement-plan";
import { renderSpending } from "../analysis/spending-report";
import { DEFAULT_ASSUMPTIONS, decomposeScenarioPrompt, projectCompound, renderCompound } from "../../scenario-studio/compound/compound-scenario";
import { AgentTool, ToolRunResult } from "./agent-tool.types";
import { ToolRegistryService } from "./tool-registry.service";

const NONE = z.object({}).strict();
const ILLUSTRATIVE_SIP_AMOUNTS = [2_000, 5_000, 10_000] as const;

// Read-only analysis tools. They are ADDED to the registry beside the existing built-ins; nothing existing is replaced.
// Every number in `text` is produced by deterministic code in ../analysis, never by a model.
@Injectable()
export class AnalysisToolsService implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly audit: FinancialAuditService,
  ) {}

  onModuleInit(): void {
    for (const tool of this.build()) this.registry.register(tool);
  }

  build(): AgentTool[] {
    return [
      {
        name: "financial_audit",
        description: "Complete multi-domain audit: income, expenses, transactions, savings, investments, SIPs, loans, insurance, goals, recurring payments and data health, with a per-domain retrieval status.",
        risk: "LOW",
        timeoutMs: AGENT_SLOW_TOOL_TIMEOUT_MS,
        schema: NONE,
        execute: async (ctx): Promise<ToolRunResult> => {
          const a = await this.audit.collect(ctx.userId);
          const failed = a.domains.filter((d) => d.status === "failed");
          return {
            text: a.markdown,
            evidence: a.domains.map((d) => ({ kind: "platform_data" as const, label: `${d.title}: ${d.status.replace("_", " ")}`, source: "financial_audit", detail: d.detail, asOf: a.asOf })),
            calculations: a.snapshot.insurance
              ? [
                  { label: "Insurance — listed premium amounts (sum)", value: formatMoney(a.snapshot.insurance.reconciliation.listedPremiumSum), method: "Exact paise-level sum of each policy's premium amount", source: "FinancialAuditService" },
                  { label: "Insurance — yearly cost", value: formatMoney(a.snapshot.insurance.annualPremium), method: "Each premium × payments per year, summed", source: "FinancialAuditService" },
                  { label: "Insurance — recorded payments (sum)", value: formatMoney(a.snapshot.insurance.reconciliation.recordedPaidTotal), method: "Sum of premium expenses recorded against each policy", source: "FinancialAuditService" },
                ]
              : [],
            warnings: [...a.warnings, ...failed.map((d) => `${d.title} could not be retrieved; its data is unknown, not empty.`)],
            assumptions: [],
            recommendations: a.risks.slice(0, 5),
            handled: true,
            data: { domains: a.domains.map((d) => ({ domain: d.domain, status: d.status, records: d.records })), risks: a.risks.length, dataQualityIssues: a.dataQuality.length },
          };
        },
      },
      {
        name: "spending_intelligence",
        description: "Spending analysis: monthly totals, category breakdown, essential vs discretionary, largest transactions, recurring payments, evidence-backed anomalies and quantified savings opportunities.",
        risk: "LOW",
        timeoutMs: AGENT_SLOW_TOOL_TIMEOUT_MS,
        schema: NONE,
        execute: async (ctx): Promise<ToolRunResult> => {
          const { report, error } = await this.audit.spending(ctx.userId);
          if (!report) return { text: `Spending history could not be retrieved (${error}). Nothing can be concluded about your spending until it loads.`, handled: false, warnings: ["Spending retrieval failed."] };
          return {
            text: renderSpending(report),
            evidence: [{ kind: "platform_data", label: `${report.categories.length} spending categories analysed`, source: "spending_intelligence", detail: `${report.completeMonthsUsed} complete months of history`, asOf: report.asOf }],
            calculations: [
              { label: "Spending this month", value: formatMoney(report.currentTotal), method: "Sum of expense transactions in the month", source: "analyzeSpending" },
              ...report.anomalies.slice(0, 5).map((a) => ({ label: `Anomaly: ${a.subject}`, value: `${formatMoney(a.actual)} vs ${formatMoney(a.expected)}`, method: a.method === "transaction_robust_z" ? "Modified z-score (median absolute deviation) within category" : "Modified z-score of the month total against earlier months", source: "analyzeSpending" })),
            ],
            warnings: report.limitations,
            assumptions: [],
            recommendations: report.opportunities.slice(0, 3).map((o) => `${o.label}: about ${formatMoney(o.monthlyAmount)}/month`),
            handled: true,
            data: { anomalyStatus: report.anomalyStatus, anomalies: report.anomalies.length, completeMonths: report.completeMonthsUsed },
          };
        },
      },
      {
        name: "financial_improvement_plan",
        description: "Prioritised improvement recommendations with measurable targets, timelines and expected impact, derived from the user's own records. Recommendation only; nothing is saved.",
        risk: "LOW",
        timeoutMs: AGENT_SLOW_TOOL_TIMEOUT_MS,
        schema: NONE,
        execute: async (ctx): Promise<ToolRunResult> => {
          const a = await this.audit.collect(ctx.userId);
          const plan = buildImprovementPlan(a.snapshot);
          const failed = a.domains.filter((d) => d.status === "failed");
          return {
            text: plan.markdown,
            evidence: [{ kind: "platform_data", label: "Plan derived from your audit snapshot", source: "financial_improvement_plan", detail: `${plan.recommendations.length} recommendations`, asOf: a.asOf }],
            calculations: [],
            warnings: [...failed.map((d) => `${d.title} could not be retrieved, so no recommendation uses it.`), ...plan.missingInputs.map((m) => `Missing: ${m}`)],
            assumptions: plan.assumptions,
            recommendations: plan.recommendations.slice(0, 5).map((r) => `${r.priority}. ${r.action}`),
            followUps: plan.recommendations.length > 0 ? ["Say which item you want saved as a tracked plan; I will confirm the target and ask for your approval first."] : [],
            handled: true,
            data: { status: "recommendations_generated", persisted: false, recommendations: plan.recommendations.length },
          };
        },
      },
      {
        name: "document_conflicts",
        description: "Lists open differences between the user's account records and values extracted from uploaded documents. Read-only: records are never overwritten.",
        risk: "LOW",
        schema: NONE,
        execute: async (ctx): Promise<ToolRunResult> => {
          const r = await this.audit.documentConflicts(ctx.userId);
          if (!r.ok) return { text: `Document comparisons could not be retrieved (${r.error}). This is unknown, not "no conflicts".`, handled: false, warnings: ["Discrepancy retrieval failed."] };
          if (r.data.length === 0) return { text: "No open differences between your records and your uploaded documents were found. (Only documents whose values were extracted and compared are covered; unprocessed documents are not checked.)", handled: true, data: { conflicts: 0 } };
          const lines = ["## Account records versus uploaded documents", "Your records were not changed. Each row shows both values so you can decide which is correct.", "| Document | Item | Field | Your account record | Document says | Detected | Status |", "|---|---|---|---|---|---|---|"];
          for (const d of r.data) lines.push(`| ${d.documentName} | ${d.entityType.toLowerCase().replace(/_/g, " ")} | ${d.field} | ${d.databaseValue} | ${d.documentValue} | ${d.createdAt.toISOString().slice(0, 10)} | ${d.status.toLowerCase().replace(/_/g, " ")} |`);
          return {
            text: lines.join("\n"),
            evidence: r.data.slice(0, 10).map((d) => ({ kind: "document" as const, label: `${d.documentName}: ${d.field}`, source: "document_conflicts", detail: `record ${d.databaseValue} vs document ${d.documentValue}`, asOf: d.createdAt.toISOString() })),
            warnings: [`${r.data.length} difference(s) need your review; nothing was overwritten.`],
            followUps: ["Review each difference in Documents and keep the correct value."],
            handled: true,
            data: { conflicts: r.data.length, overwritten: 0 },
          };
        },
      },
      {
        name: "compound_scenario",
        description: "Runs several what-if scenarios from one request (salary change, expense reduction, SIP change), each independently, plus a combined run and a 1–20 year comparison.",
        risk: "LOW",
        timeoutMs: AGENT_SLOW_TOOL_TIMEOUT_MS,
        schema: z.object({ prompt: z.string().trim().min(3).max(500) }).strict(),
        execute: async (ctx, input: { prompt: string }): Promise<ToolRunResult> => {
          const d = decomposeScenarioPrompt(input.prompt);
          if (!d.compound) return { text: "This request describes a single scenario; it is handled by the single-scenario simulator.", handled: false };
          const b = await this.audit.scenarioBaseline(ctx.userId);
          if ("error" in b) return { text: `A baseline could not be built (${b.error}), so no scenario was run.`, handled: false, warnings: ["Scenario baseline unavailable."] };
          if (b.baseline.monthlyIncome <= 0 && d.scenarios.some((s) => s.type === "SALARY_HIKE" || s.type === "SALARY_DROP")) {
            return { text: "No income is recorded, so a salary-based scenario cannot be calculated. Add your income and ask again.", handled: true, followUps: ["Add your monthly income, then repeat the request."], data: { status: "awaiting_user_input" } };
          }
          const p = projectCompound(b.baseline, d.scenarios, DEFAULT_ASSUMPTIONS, ILLUSTRATIVE_SIP_AMOUNTS);
          const ran = p.columns.filter((c) => c.kind === "single" || c.kind === "combined").length;
          return {
            text: renderCompound(d, p, b.baseline),
            evidence: [{ kind: "estimate", label: `Compound what-if: ${d.scenarios.map((s) => s.label).join(", ")}`, source: "compound_scenario", detail: b.basis.join("; ") }],
            calculations: p.columns.filter((c) => c.kind !== "baseline").map((c) => ({ label: `${c.label} — 10-year total`, value: formatMoney(c.byHorizon.find((h) => h.years === 10)?.total ?? 0), method: "Monthly-compounded future value + retained cash", source: "projectCompound" })),
            warnings: p.columns.flatMap((c) => c.warnings),
            assumptions: [`Return ${DEFAULT_ASSUMPTIONS.annualReturnPercent}% a year and inflation ${DEFAULT_ASSUMPTIONS.inflationPercent}% a year are illustrative assumptions, not your inputs.`, ...b.basis],
            followUps: p.questions,
            handled: true,
            data: { status: p.questions.length > 0 ? "partially_completed" : "completed", scenariosRun: ran, scenariosAwaitingInput: p.questions.length },
          };
        },
      },
    ];
  }
}
