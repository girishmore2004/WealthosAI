import { Injectable, OnModuleInit } from "@nestjs/common";
import { GoalType } from "@wealthos/db";
import { z } from "zod";
import { PrismaService } from "../../../prisma/prisma.service";
import { formatINR } from "../../../common/utils/currency.util";
import { GoalsService } from "../../../goals/goals.service";
import { AiQueueService } from "../../ops/ai-queue.service";
import { FinancialEngineService } from "../../financial-engine/financial-engine.service";
import { FinancialToolsService } from "../../financial-engine/financial-tools.service";
import { renderRawFacts } from "../../financial-engine/answer-composer";
import { ToolResult } from "../../financial-engine/financial-types";
import { RagService } from "../../rag/rag.service";
import { ScenarioStudioService } from "../../scenario-studio/scenario-studio.service";
import { MlInsightsService } from "../../ml-insights/ml-insights.service";
import { AgenticCoachService } from "../../coach/agentic-coach.service";
import { FinanceCalculatorService } from "../../coach/calculation/finance-calculator.service";
import { FinancialPlanAgentService } from "../../coach/planning/financial-plan-agent.service";
import { TaskAgentService } from "../../coach/execution/task-agent.service";
import { CoachPlanService } from "../../coach/plans/coach-plan.service";
import { COACH_PLAN_TARGET_METRICS } from "../../coach/coach2.constants";
import { FinancialSnapshotService } from "../memory/financial-snapshot.service";
import { sanitizeUntrusted } from "../security/untrusted-content";
import { AGENT_SLOW_TOOL_TIMEOUT_MS } from "../agent.constants";
import { AgentTool, AgentToolContext, ToolForbiddenError, ToolRunResult } from "./agent-tool.types";
import { ToolRegistryService } from "./tool-registry.service";

const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "use YYYY-MM");
const QUESTION = z.string().trim().min(3).max(500);
const ISO_DATE = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date");

const METRICS = ["cash_flow", "net_worth", "expense_breakdown", "year_to_date", "investment_summary", "loan_summary", "insurance_summary", "emergency_coverage", "emergency_fund", "receivables", "data_health"] as const;
type Metric = (typeof METRICS)[number];

export const createGoalSchema = z
  .object({
    type: z.nativeEnum(GoalType),
    name: z.string().trim().min(2).max(80),
    targetAmount: z.number().positive().max(1e12),
    targetDate: ISO_DATE,
    monthlyContribution: z.number().min(0).max(1e9).optional(),
    assumedAnnualReturnPercent: z.number().min(0).max(30).optional(),
  })
  .strict();

export const updateGoalSchema = z
  .object({
    goalId: z.string().min(1).max(64),
    name: z.string().trim().min(2).max(80).optional(),
    targetAmount: z.number().positive().max(1e12).optional(),
    targetDate: ISO_DATE.optional(),
    monthlyContribution: z.number().min(0).max(1e9).optional(),
    assumedAnnualReturnPercent: z.number().min(0).max(30).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, { message: "nothing to update" });

export const createPlanSchema = z
  .object({
    type: z.enum(["DEBT_PAYOFF", "SAVINGS_TARGET", "RETIREMENT", "INVESTMENT_ALLOCATION", "CUSTOM"]),
    title: z.string().trim().min(3).max(120),
    objective: z.string().trim().min(3).max(500),
    targetMetricType: z.enum(COACH_PLAN_TARGET_METRICS as unknown as [string, ...string[]]),
    targetValue: z.number().min(0),
    targetDate: ISO_DATE,
    startingValue: z.number().min(0),
    linkedGoalId: z.string().max(64).optional(),
    linkedLoanId: z.string().max(64).optional(),
  })
  .strict();

export const createTaskSchema = z.object({ title: z.string().trim().min(3).max(120), detail: z.string().trim().max(500).default("") }).strict();

const money = (n: number | string) => formatINR(n);

// Registers the agent's allowlist. Every tool delegates to an EXISTING service; nothing here recalculates a financial
// number or writes to a table directly (except reading Budget / ingestion rows that have no service). Reads are LOW risk and
// run automatically; anything that writes goes through approval (see requiresApproval()).
@Injectable()
export class BuiltinToolsService implements OnModuleInit {
  constructor(
    private registry: ToolRegistryService,
    private prisma: PrismaService,
    private engine: FinancialEngineService,
    private fin: FinancialToolsService,
    private rag: RagService,
    private calc: FinanceCalculatorService,
    private scenario: ScenarioStudioService,
    private ml: MlInsightsService,
    private coach: AgenticCoachService,
    private goals: GoalsService,
    private planAgent: FinancialPlanAgentService,
    private plans: CoachPlanService,
    private tasks: TaskAgentService,
    private snapshots: FinancialSnapshotService,
    private queue: AiQueueService,
  ) {}

  onModuleInit(): void {
    for (const tool of this.build()) this.registry.register(tool);
  }

  build(): AgentTool[] {
    const metricTool = (name: string, description: string, allowed: readonly Metric[]): AgentTool =>
      ({
        name,
        description,
        risk: "LOW",
        schema: z.object({ metric: z.enum(allowed as unknown as [Metric, ...Metric[]]), month: MONTH.optional() }).strict(),
        execute: (ctx: AgentToolContext, input: { metric: Metric; month?: string }) => this.runMetric(ctx.userId, input.metric, input.month),
      }) as AgentTool;

    return [
      // --- LOW: read-only -------------------------------------------------------------------------------
      {
        name: "financial_engine_answer",
        description: "Answers a question about the user's own live financial data using the deterministic finance engine (verified figures).",
        risk: "LOW",
        schema: z.object({ question: QUESTION }).strict(),
        execute: async (ctx, input: { question: string }) => {
          const r = await this.engine.ask(ctx.userId, input.question);
          if (!r.handled || !r.answer) {
            return { text: "", handled: false, data: { handoff: r.handoff } };
          }
          return {
            text: r.answer,
            handled: true,
            facts: r.results ?? [],
            evidence: r.tools.map((t) => ({ kind: "platform_data" as const, label: t.tool, source: "financial_engine", detail: `${t.basis.toLowerCase()} · ${t.period.toLowerCase()}`, asOf: t.asOfDate })),
            warnings: [...r.dataHealth.filter((w) => w.severity !== "INFO").map((w) => w.message), ...(r.usedFallback ? ["The figures are shown plainly because the worded answer did not pass verification."] : [])],
            data: { intent: r.intent, verification: r.verification },
          };
        },
      },
      metricTool("financial_database", "Reads one named, bounded metric from the user's live data (no free-form queries).", METRICS),
      metricTool("investment_analysis", "Investment portfolio value, contributions and SIPs.", ["investment_summary"]),
      metricTool("budget_analysis", "Spending by category and cash flow for a month, with the user's budget limits.", ["expense_breakdown", "cash_flow", "year_to_date"]),
      metricTool("loan_analysis", "Loans, EMIs and outstanding balances.", ["loan_summary"]),
      metricTool("insurance_analysis", "Insurance policies, cover and premiums.", ["insurance_summary"]),
      {
        name: "goal_planning",
        description: "Lists the user's goals with progress and the monthly contribution each needs, plus active plans.",
        risk: "LOW",
        schema: z.object({}).strict(),
        execute: async (ctx) => {
          const [goals, plans] = await Promise.all([this.goals.list(ctx.userId), this.plans.list(ctx.userId)]);
          const active = plans.filter((p) => p.status === "ACTIVE" || p.status === "AT_RISK");
          if (goals.length === 0 && active.length === 0) return { text: "You have no active goals or plans yet.", evidence: [{ kind: "platform_data", label: "Goals & plans", source: "goals" }] };
          const lines = goals.slice(0, 10).map((g) => `Goal "${g.name}": target ${money(g.targetAmount)} by ${g.targetDate.slice(0, 10)}, ${g.progressPercent.toFixed(0)}% funded, needs ${money(g.requiredMonthlyContribution)} per month (${g.probabilityOfSuccess.replace("_", " ").toLowerCase()}).`);
          for (const p of active.slice(0, 5)) lines.push(`Plan "${p.title}": ${p.status.replace("_", " ").toLowerCase()}, target ${money(Number(p.targetValue))} by ${new Date(p.targetDate).toISOString().slice(0, 10)}.`);
          return { text: lines.join("\n"), evidence: [{ kind: "platform_data", label: "Goals & plans", source: "goals", asOf: new Date().toISOString() }], data: { goals: goals.length, plans: active.length } };
        },
      },
      {
        name: "financial_history",
        description: "Compares the user's two most recent dated financial snapshots (net worth, cash flow, investments, loans).",
        risk: "LOW",
        schema: z.object({}).strict(),
        execute: async (ctx) => {
          // Make sure there is something to compare against today.
          await this.snapshots.capture(ctx.userId).catch(() => null);
          const cmp = await this.snapshots.compareLatest(ctx.userId);
          if (!cmp) return { text: "I only have one dated snapshot of your finances so far, so there is nothing to compare yet. I save one each day you use the assistant.", handled: true };
          const changed = cmp.changes.filter((c) => c.direction !== "flat").slice(0, 12);
          const text = changed.length === 0 ? `Between ${cmp.from} and ${cmp.to} none of the tracked figures changed.` : changed.map((c) => `${c.label}: ${c.before} → ${c.after} (${c.delta}) between ${cmp.from} and ${cmp.to}`).join("\n");
          return { text, evidence: [{ kind: "platform_data", label: "Dated financial snapshots", source: "agent_snapshot", detail: `${cmp.from} → ${cmp.to}` }], data: { from: cmp.from, to: cmp.to, changes: changed.length } };
        },
      },
      {
        name: "rag_search",
        description: "Searches the user's own uploaded documents and indexed records and returns a grounded, cited answer.",
        risk: "LOW",
        timeoutMs: AGENT_SLOW_TOOL_TIMEOUT_MS,
        schema: z.object({ query: QUESTION }).strict(),
        execute: async (ctx, input: { query: string }) => {
          const r = await this.rag.search(ctx.userId, input.query);
          if (!r.hasEvidence) {
            return { text: "I couldn't find anything about that in your documents or records, so I won't guess. Uploading the relevant document would let me answer.", handled: true, untrusted: false, evidence: [], data: { hasEvidence: false } };
          }
          // Passages are user documents: sanitise, and tell the user if a document tried to give instructions.
          const clean = sanitizeUntrusted(r.answer, 3000);
          const warnings: string[] = [];
          if (clean.flags.length > 0) warnings.push("A document contained text that looked like instructions to an assistant. I ignored it and treated the document as data only.");
          if (r.hallucinationRisk === "high") warnings.push("This answer has weak support in your documents; please double-check the cited sources.");
          return {
            text: clean.text,
            untrusted: true,
            evidence: r.citedSources.slice(0, 6).map((c) => ({ kind: "document" as const, label: sanitizeUntrusted(c.title, 120).text, source: c.sourceType, detail: `${c.confidence} confidence: ${sanitizeUntrusted(c.snippet, 200).text}` })),
            warnings,
            data: { hasEvidence: true, retrievalConfidence: r.retrievalConfidence, answerConfidence: r.answerConfidence, groundingScore: r.groundingScore, hallucinationRisk: r.hallucinationRisk, citations: r.citedSources.length },
          };
        },
      },
      {
        name: "financial_calculator",
        description: "Deterministic calculations: loan payoff with extra payments, retirement corpus gap, current-year tax estimate, portfolio projection.",
        risk: "LOW",
        schema: z
          .object({
            calculation: z.enum(["loan_payoff_extra", "retirement_gap", "tax_estimate", "portfolio_projection"]),
            loanId: z.string().max(64).optional(),
            extraMonthly: z.number().min(0).max(1e8).optional(),
            years: z.number().int().min(1).max(50).optional(),
            annualReturnPercent: z.number().min(0).max(30).optional(),
          })
          .strict(),
        authorizeResources: async (ctx, input) => {
          if (input.loanId) {
            const loan = await this.prisma.client.loan.findFirst({ where: { id: input.loanId, userId: ctx.userId }, select: { id: true } });
            if (!loan) throw new ToolForbiddenError();
          }
        },
        execute: async (ctx, input): Promise<ToolRunResult> => {
          const asOf = new Date().toISOString();
          switch (input.calculation) {
            case "loan_payoff_extra": {
              if (!input.loanId || input.extraMonthly === undefined) return { text: "Tell me which loan and how much extra you would pay each month.", handled: false, warnings: [] };
              const r = await this.calc.loanPayoffWithExtraMonthly(ctx.userId, input.loanId, input.extraMonthly);
              return {
                text: `Paying ${money(input.extraMonthly)} extra each month, this loan would be cleared in ${r.monthsToPayoff} months (${r.monthsSaved} months sooner), saving ${money(r.interestSaved)} in interest, with payoff around ${r.projectedPayoffDate.slice(0, 10)}.`,
                calculations: [{ label: "Loan payoff with extra payment", value: `${r.monthsToPayoff} months; interest saved ${money(r.interestSaved)}`, method: "Existing loan amortisation schedule", source: "FinanceCalculatorService", basis: `extra ${money(input.extraMonthly)}/month` }],
                evidence: [{ kind: "platform_data", label: "Loan amortisation schedule", source: "loans", asOf }],
                assumptions: ["The EMI and interest rate stay as recorded for this loan."],
              };
            }
            case "retirement_gap": {
              const r = await this.calc.retirementCorpusGap(ctx.userId);
              return {
                text: `Corpus required at retirement: ${money(r.corpusRequired)}. Shortfall: ${money(r.corpusGap)}. Monthly SIP needed to close it: ${money(r.requiredMonthlySip)} over ${r.yearsToRetirement} years.`,
                calculations: [{ label: "Retirement corpus gap", value: money(r.corpusGap), method: "Existing retirement plan computation", source: "RetirementService" }],
                evidence: [{ kind: "platform_data", label: "Retirement plan", source: "retirement", asOf }],
                assumptions: ["Uses the inflation and return assumptions saved in your retirement plan."],
              };
            }
            case "tax_estimate": {
              const r = await this.calc.currentYearTaxEstimate(ctx.userId);
              const text = Object.entries(r as unknown as Record<string, unknown>).filter(([, v]) => typeof v === "string" || typeof v === "number").slice(0, 10).map(([k, v]) => `${k}: ${typeof v === "number" ? money(v) : v}`).join("\n");
              return { text: text || "No tax estimate is available yet.", calculations: [{ label: "Current-year tax estimate", value: "see figures", method: "Existing tax module", source: "TaxService" }], evidence: [{ kind: "platform_data", label: "Tax estimate", source: "tax", asOf }], assumptions: ["An estimate from the data in your account; not tax advice."] };
            }
            case "portfolio_projection": {
              const years = input.years ?? 10;
              const r = await this.fin.projectPortfolio(ctx.userId, { years, annualReturn: input.annualReturnPercent !== undefined ? String(input.annualReturnPercent) : null });
              return {
                text: renderToolResults([r]),
                facts: [r],
                calculations: [{ label: `Portfolio projection (${years} years)`, value: r.facts.projectedValue ? money(r.facts.projectedValue.value) : "needs a return assumption", method: "Existing portfolio projection", source: "FinancialToolsService.projectPortfolio" }],
                evidence: [{ kind: "estimate", label: "Portfolio projection", source: "projection", asOf: r.asOfDate }],
                assumptions: r.warnings.map((w) => w.message),
              };
            }
            default:
              return { text: "That calculation is not supported.", handled: false };
          }
        },
      },
      {
        name: "scenario_simulation",
        description: "Runs a what-if scenario (salary change, SIP change, house purchase, prepayment, ...) with the deterministic Scenario Studio.",
        risk: "LOW",
        timeoutMs: AGENT_SLOW_TOOL_TIMEOUT_MS,
        schema: z.object({ prompt: QUESTION }).strict(),
        execute: async (ctx, input: { prompt: string }) => {
          const r = await this.scenario.build(ctx.userId, input.prompt);
          if (!r.understood || !r.scenarioType) {
            return { text: r.explanation, handled: true, data: { understood: false }, followUps: ["Say what changes and by how much, e.g. “What if my salary rises by 20%?” or “What if I prepay ₹5 lakh on my home loan?”"] };
          }
          const ranked = r.ranked.slice(0, 4);
          const lines = [r.explanation, ...ranked.map((v) => `${v.label}: ${v.feasible ? "feasible" : "not feasible"}; net worth effect after 5 years ${money(v.netWorthDeltaIn5Years)}. ${v.feasibilityNote}`)];
          return {
            text: lines.join("\n"),
            evidence: [{ kind: "estimate", label: `Scenario: ${r.scenarioType}`, source: "scenario_studio", detail: r.verificationPassed ? "numbers verified" : "numbers could not be fully verified" }],
            calculations: ranked.map((v) => ({ label: `${v.label} — 5-year net worth effect`, value: money(v.netWorthDeltaIn5Years), method: "Deterministic scenario simulator", source: "ScenarioStudioService" })),
            assumptions: ["Projections assume your current income, spending and the stated change; markets and life events can differ."],
            warnings: r.verificationPassed ? [] : ["Some figures in this scenario summary could not be independently verified."],
            data: { scenarioType: r.scenarioType, variants: r.variants.length },
          };
        },
      },
      {
        name: "ml_insights",
        description: "Statistical insights: unusual spending, cash-flow forecast, debt risk, goal success, behaviour drift.",
        risk: "LOW",
        schema: z.object({ focus: z.enum(["anomalies", "forecast", "debt_risk", "goals", "drift", "all"]).default("all") }).strict(),
        execute: async (ctx, input: { focus: "anomalies" | "forecast" | "debt_risk" | "goals" | "drift" | "all" }) => {
          const s = await this.ml.summary(ctx.userId);
          const want = (f: string) => input.focus === "all" || input.focus === f;
          const parts: string[] = [];
          const calcs: ToolRunResult["calculations"] = [];
          if (want("anomalies")) {
            const a = s.anomalies.prediction.slice(0, 3);
            parts.push(a.length === 0 ? "No unusual expenses were detected." : `Unusual expenses: ${a.map((x) => `${x.categoryName} ${money(x.amount)} (typical ${money(x.categoryMedian)})`).join("; ")}.`);
          }
          if (want("forecast")) {
            const f = s.cashflowForecast;
            parts.push(`Cash-flow forecast: ${f.explanation}`);
            calcs.push({ label: "Next-month cash flow", value: money(f.prediction.nextMonthProjectedCashflow), method: f.method, source: "MlInsightsService", basis: `95% range ${money(f.prediction.confidenceInterval95.lower)} to ${money(f.prediction.confidenceInterval95.upper)}` });
          }
          if (want("debt_risk")) parts.push(`Debt risk: ${s.debtRisk.explanation}`);
          if (want("goals")) parts.push(`Goal success: ${s.goalSuccess.explanation}`);
          if (want("drift")) parts.push(`Spending behaviour: ${s.drift.explanation}`);
          return {
            text: parts.join("\n"),
            calculations: calcs,
            evidence: [{ kind: "estimate", label: "ML insights", source: "ml_insights", asOf: new Date().toISOString() }],
            assumptions: ["Statistical estimates from your past data; they are not guarantees."],
          };
        },
      },
      {
        name: "coach_advisor",
        description: "The existing agentic coach: multi-step financial analysis, prioritisation, planning proposals and plan progress checks.",
        risk: "LOW",
        timeoutMs: AGENT_SLOW_TOOL_TIMEOUT_MS,
        schema: z.object({ question: QUESTION }).strict(),
        execute: async (ctx, input: { question: string }) => {
          const r = await this.coach.ask(ctx.userId, input.question);
          const report = r.report ?? null;
          const proposed = (report?.executionActions ?? [])
            .filter((a) => a.kind === "CREATE_PLAN" && a.payload)
            .map((a) => ({ tool: "create_plan", input: a.payload as Record<string, unknown>, summary: a.preview?.title ? `Create plan "${a.preview.title}"` : a.label, preview: a.preview?.changes }));
          return {
            text: report ? [report.directAnswer, report.explanation].filter(Boolean).join("\n\n") : r.answer,
            evidence: [
              { kind: "platform_data" as const, label: "Coach analysis", source: "agentic_coach", detail: r.verificationPassed ? "numbers verified" : "numbers not fully verified" },
              ...(report?.citations ?? []).slice(0, 5).map((c) => ({ kind: "document" as const, label: c.title, source: c.sourceType, detail: c.snippet.slice(0, 160) })),
            ],
            calculations: (report?.calculations ?? []).slice(0, 8).map((c) => ({ label: c.label, value: c.display, method: c.formula, source: "coach calculation engine" })),
            assumptions: report?.assumptions ?? [],
            recommendations: (report?.recommendations ?? []).slice(0, 4).map((x) => `${x.title}: ${x.nextStep}`),
            warnings: [...(report?.dataGaps ?? []).map((g) => g.message), ...(r.verificationPassed ? [] : ["Some figures in this answer could not be independently verified."])],
            followUps: report?.followUpSuggestions ?? [],
            proposedActions: proposed,
            data: { planProposed: proposed.length > 0, confidence: r.confidence },
          };
        },
      },
      {
        name: "statement_ingestion_status",
        description: "Shows the status of uploaded statements and documents being processed, and the review batches they produced.",
        risk: "LOW",
        schema: z.object({}).strict(),
        execute: async (ctx) => {
          const [docs, batches] = await Promise.all([
            this.prisma.client.document.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, fileName: true, ocrStatus: true, category: true } }),
            this.prisma.client.ingestionBatch.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: "desc" }, take: 5, select: { sourceLabel: true, totalLines: true, parsedCount: true, unparsedCount: true, createdAt: true } }),
          ]);
          if (docs.length === 0 && batches.length === 0) return { text: "You haven't uploaded any statements or documents yet.", evidence: [] };
          const lines = [
            ...docs.map((d) => `Document "${sanitizeUntrusted(d.fileName, 80).text}" (${d.category.toLowerCase()}): processing ${d.ocrStatus.replace("_", " ").toLowerCase()}.`),
            ...batches.map((b) => `Import "${sanitizeUntrusted(b.sourceLabel, 80).text}": ${b.parsedCount} of ${b.totalLines} lines read, ${b.unparsedCount} need attention (${b.createdAt.toISOString().slice(0, 10)}). Review them in the import screen before anything is added to your records.`),
          ];
          return { text: lines.join("\n"), evidence: [{ kind: "platform_data", label: "Documents & imports", source: "documents" }], data: { documents: docs.length, batches: batches.length } };
        },
      },
      {
        name: "list_tasks",
        description: "Lists the user's open follow-up tasks.",
        risk: "LOW",
        schema: z.object({}).strict(),
        execute: async (ctx) => {
          const open = await this.tasks.listOpenTasks(ctx.userId);
          if (open.length === 0) return { text: "You have no open tasks.", evidence: [{ kind: "platform_data", label: "Tasks", source: "coach_tasks" }] };
          return { text: open.slice(0, 10).map((t) => `${t.title}${t.dueDate ? ` (due ${t.dueDate.toISOString().slice(0, 10)})` : ""}`).join("\n"), evidence: [{ kind: "platform_data", label: "Tasks", source: "coach_tasks" }], data: { open: open.length } };
        },
      },

      // --- MEDIUM / HIGH: writes (approval policy in requiresApproval) ---------------------------------------
      {
        name: "create_task",
        description: "Creates a follow-up task / reminder for the user. Non-consequential, so it does not need approval.",
        risk: "MEDIUM",
        approval: "never",
        schema: createTaskSchema,
        summarize: (i) => `Add task "${i.title}"`,
        execute: async (ctx, input: z.infer<typeof createTaskSchema>) => {
          const id = await this.tasks.createAdHocTask(ctx.userId, input.title, input.detail, null);
          return { text: `Added the task "${input.title}".`, evidence: [{ kind: "platform_data", label: "Task created", source: "coach_tasks", detail: id }], data: { taskId: id } };
        },
      },
      {
        name: "process_document",
        description: "Re-starts processing (OCR and statement parsing) of one of the user's uploaded documents that is pending or failed. Creates review items only; nothing is added to the ledger.",
        risk: "MEDIUM",
        approval: "never",
        schema: z.object({ documentId: z.string().min(1).max(64) }).strict(),
        authorizeResources: async (ctx, input) => {
          const d = await this.prisma.client.document.findFirst({ where: { id: input.documentId, userId: ctx.userId }, select: { id: true } });
          if (!d) throw new ToolForbiddenError();
        },
        execute: async (ctx, input: { documentId: string }) => {
          const d = await this.prisma.client.document.findFirst({ where: { id: input.documentId, userId: ctx.userId } });
          if (!d) throw new ToolForbiddenError();
          if (d.ocrStatus === "DONE") return { text: `"${d.fileName}" has already been processed. Its results are waiting in the import review screen.`, data: { status: d.ocrStatus } };
          if (d.ocrStatus === "NOT_APPLICABLE") return { text: `"${d.fileName}" is not a type of document that needs text extraction.`, data: { status: d.ocrStatus } };
          await this.queue.enqueue("document.ocr", { documentId: d.id, userId: ctx.userId, category: d.category }, { userId: ctx.userId, idempotencyKey: `agent-ocr:${d.id}:${d.ocrStatus}` });
          return { text: `Processing of "${d.fileName}" has been queued. I'll have the result once extraction finishes; imported lines still need your review before they reach your records.`, evidence: [{ kind: "platform_data", label: "Document queued", source: "documents", detail: d.id }], data: { status: "queued" } };
        },
      },
      {
        name: "create_plan",
        description: "Creates a tracked financial plan with starter tasks from a validated proposal.",
        risk: "MEDIUM",
        approval: "always",
        schema: createPlanSchema,
        summarize: (i) => `Create plan "${i.title}" — target ${money(i.targetValue)} by ${i.targetDate.slice(0, 10)}`,
        preview: (i) => [
          { label: "Type", value: i.type.replace("_", " ").toLowerCase() },
          { label: "Target", value: money(i.targetValue) },
          { label: "By", value: i.targetDate.slice(0, 10) },
          { label: "Starting from", value: money(i.startingValue) },
        ],
        authorizeResources: async (ctx, input) => {
          if (input.linkedGoalId && !(await this.prisma.client.goal.findFirst({ where: { id: input.linkedGoalId, userId: ctx.userId }, select: { id: true } }))) throw new ToolForbiddenError();
          if (input.linkedLoanId && !(await this.prisma.client.loan.findFirst({ where: { id: input.linkedLoanId, userId: ctx.userId }, select: { id: true } }))) throw new ToolForbiddenError();
        },
        execute: async (ctx, input: z.infer<typeof createPlanSchema>) => {
          // Same duplicate guard as POST /coach/v2/plans: confirming twice must not create two plans.
          const existing = await this.plans.list(ctx.userId);
          const day = new Date(input.targetDate).toISOString().slice(0, 10);
          const dup = existing.find((p) => (p.status === "ACTIVE" || p.status === "AT_RISK") && p.type === input.type && p.title === input.title && Number(p.targetValue) === input.targetValue && new Date(p.targetDate).toISOString().slice(0, 10) === day);
          if (dup) return { text: `You already have the plan "${input.title}", so I didn't create a second one.`, data: { planId: dup.id, alreadyExisted: true } };
          const { planId, steps } = await this.planAgent.createPlan({ userId: ctx.userId, type: input.type, title: input.title, objective: input.objective, targetMetricType: input.targetMetricType as never, targetValue: input.targetValue, targetDate: new Date(input.targetDate), startingValue: input.startingValue, linkedGoalId: input.linkedGoalId ?? null, linkedLoanId: input.linkedLoanId ?? null });
          const taskIds = await this.tasks.createInitialTasksFromPlan(ctx.userId, planId, input.title, steps, null);
          return { text: `Created the plan "${input.title}" with ${steps.length} milestones and ${taskIds.length} starter tasks.`, evidence: [{ kind: "platform_data", label: "Plan created", source: "coach_plans", detail: planId }], data: { planId, steps: steps.length, tasks: taskIds.length } };
        },
      },
      {
        name: "create_goal",
        description: "Creates a financial goal through the goals service (same validation as the Goals page).",
        risk: "HIGH",
        schema: createGoalSchema,
        summarize: (i) => `Create goal "${i.name}" — ${money(i.targetAmount)} by ${i.targetDate.slice(0, 10)}`,
        preview: (i) => [
          { label: "Goal type", value: i.type.replace(/_/g, " ").toLowerCase() },
          { label: "Target", value: money(i.targetAmount) },
          { label: "By", value: i.targetDate.slice(0, 10) },
          ...(i.monthlyContribution !== undefined ? [{ label: "Monthly contribution", value: money(i.monthlyContribution) }] : []),
        ],
        execute: async (ctx, input: z.infer<typeof createGoalSchema>) => {
          const goal = await this.goals.create(ctx.userId, input as never);
          const g = goal as { id: string; name: string };
          return { text: `Created the goal "${g.name}".`, evidence: [{ kind: "platform_data", label: "Goal created", source: "goals", detail: g.id }], data: { goalId: g.id } };
        },
      },
      {
        name: "update_goal",
        description: "Updates one of the user's goals through the goals service.",
        risk: "HIGH",
        schema: updateGoalSchema,
        summarize: (i) => `Update goal ${i.goalId}: ${Object.entries(i).filter(([k]) => k !== "goalId").map(([k, v]) => `${k} → ${v}`).join(", ")}`,
        authorizeResources: async (ctx, input) => {
          const g = await this.prisma.client.goal.findFirst({ where: { id: input.goalId, userId: ctx.userId }, select: { id: true } });
          if (!g) throw new ToolForbiddenError();
        },
        execute: async (ctx, input: z.infer<typeof updateGoalSchema>) => {
          const { goalId, ...changes } = input;
          const goal = (await this.goals.update(ctx.userId, goalId, changes as never)) as { id: string; name: string };
          return { text: `Updated the goal "${goal.name}".`, evidence: [{ kind: "platform_data", label: "Goal updated", source: "goals", detail: goal.id }], data: { goalId: goal.id } };
        },
      },
    ];
  }

  private async runMetric(userId: string, metric: Metric, month?: string): Promise<ToolRunResult> {
    let result: ToolResult;
    switch (metric) {
      case "cash_flow": result = await this.fin.getCashFlow(userId, month); break;
      case "net_worth": result = await this.fin.getNetWorth(userId); break;
      case "expense_breakdown": result = await this.fin.getExpenseBreakdown(userId); break;
      case "year_to_date": result = await this.fin.getYearToDate(userId); break;
      case "investment_summary": result = await this.fin.getInvestmentSummary(userId); break;
      case "loan_summary": result = await this.fin.getLoanSummary(userId); break;
      case "insurance_summary": result = await this.fin.getInsuranceSummary(userId); break;
      case "emergency_coverage": result = await this.fin.calculateEmergencyCoverage(userId); break;
      case "emergency_fund": result = await this.fin.getEmergencyFundOverview(userId); break;
      case "receivables": result = await this.fin.getReceivablesSummary(userId); break;
      case "data_health": result = await this.fin.getDataHealth(userId); break;
    }
    const results = [result];
    let text = renderToolResults(results);
    if (metric === "expense_breakdown") {
      const budgets = await this.prisma.client.budget.findMany({ where: { userId }, include: { category: { select: { name: true } } }, take: 30 });
      if (budgets.length > 0) text += `\n\nYour monthly budget limits: ${budgets.map((b) => `${b.category.name} ${money(Number(b.monthlyAmount))}`).join("; ")}.`;
    }
    return {
      text,
      facts: results,
      evidence: [{ kind: "platform_data", label: result.tool, source: "financial_tools", detail: `${result.basis.toLowerCase()} · ${result.period.toLowerCase()}`, asOf: result.asOfDate }],
      warnings: result.warnings.filter((w) => w.severity !== "INFO").map((w) => w.message),
      assumptions: result.missing.length > 0 ? [`Not available from your data: ${result.missing.join(", ")}.`] : [],
    };
  }
}

function renderToolResults(results: ToolResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(renderRawFacts([r]));
    for (const row of r.rows ?? []) lines.push(`${row.label}: ${renderRawFacts([{ ...r, facts: row.facts }]).replace(/\n/g, "; ")}`);
  }
  return lines.filter(Boolean).join("\n");
}
