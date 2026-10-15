import { z } from "zod";
import { CoachReportDTO } from "@wealthos/types";

// The single validation gate for everything the Coach returns in `report`.
//
// `z.ZodType<CoachReportDTO>` makes the compiler prove this schema and the shared DTO (which the web app
// renders) can never drift apart. Bounds are deliberately generous for real answers but finite, so a
// runaway builder or an oversized retrieved snippet cannot inflate a response without limit.

const text = (max: number) => z.string().max(max);
const short = text(300);
const long = text(2000);
const finite = z.number().finite();

const dataQuality = z.enum([
  "verified",
  "verified_zero",
  "missing",
  "empty",
  "failed_source",
  "stale",
  "conflicting",
  "incomplete_period",
  "estimate",
  "document_extraction",
]);

const tone = z.enum(["good", "warn", "bad", "info"]);

const snapshotItem = z.object({
  key: short,
  label: short,
  value: finite.nullable(),
  display: short,
  unit: z.enum(["INR", "%", "months", "count", "text"]),
  quality: dataQuality,
  note: long.optional(),
});

const evidenceCard = z.object({
  id: short,
  sourceType: short,
  sourceName: short,
  reference: short.optional(),
  period: short.optional(),
  value: short.optional(),
  excerpt: text(600).optional(),
  calculationBasis: long.optional(),
  citation: z.object({ chunkId: short, page: z.number().int().positive().optional() }).optional(),
  quality: dataQuality,
});

const calculation = z.object({
  id: short,
  label: short,
  formula: long,
  inputs: z.array(z.object({ label: short, value: short })).max(20),
  result: finite.nullable(),
  display: short,
  unit: z.enum(["INR", "%", "months", "count"]),
  period: short.optional(),
  assumptions: z.array(long).max(12),
  quality: dataQuality,
});

const prediction = z.object({
  id: short,
  label: short,
  display: short,
  value: finite.nullable(),
  unit: z.enum(["INR", "%", "months"]),
  horizon: short,
  assumptions: z.array(long).max(12),
});

const scenarioComparison = z.object({
  scenarioType: short,
  label: short,
  params: z.record(z.union([finite, short])),
  rows: z
    .array(
      z.object({
        metric: short,
        baseline: short,
        proposed: short,
        delta: short,
        direction: z.enum(["better", "worse", "neutral"]),
      }),
    )
    .max(20),
  source: z.enum(["simulator", "scenario_studio"]),
  narrative: text(1500).optional(),
  assumptions: z.array(long).max(20),
});

const recommendation = z.object({
  id: short,
  rank: z.number().int().positive(),
  title: short,
  issue: long,
  evidence: z.array(long).max(8),
  whyItMatters: long,
  nextStep: long,
  estimatedImpact: z.object({ display: short, formula: long }).optional(),
  priority: z.object({ level: z.enum(["urgent", "high", "medium", "low"]), reason: long }),
  feasibility: long,
  tradeoffs: z.array(long).max(6),
  missingInfo: z.array(long).max(6),
  destination: z.object({ label: short, href: short }).optional(),
});

const chart = z.object({
  id: short,
  kind: z.enum(["bar", "line", "pie"]),
  title: short,
  unit: z.enum(["INR", "%", "months"]),
  xKey: short,
  series: z.array(z.object({ key: short, label: short })).min(1).max(8),
  data: z.array(z.record(z.union([z.string().max(120), finite, z.null()]))).max(60),
  note: long.optional(),
  source: short,
});

const executionAction = z.object({
  id: short,
  kind: z.enum(["OPEN", "OPEN_SCENARIO_STUDIO", "CREATE_PLAN"]),
  label: short,
  description: long,
  href: short.optional(),
  requiresConfirmation: z.boolean(),
  payload: z.record(z.unknown()).optional(),
  preview: z
    .object({ title: short, changes: z.array(z.object({ label: short, value: short })).max(12) })
    .optional(),
});

export const coachReportSchema: z.ZodType<CoachReportDTO> = z.object({
  directAnswer: text(4000).min(1),
  explanation: text(4000).optional(),
  answerType: z.enum(["fact", "health", "what_if", "planning", "document", "multi_step", "clarification", "legacy"]),
  evidenceSufficiency: z.enum(["sufficient", "partial", "insufficient"]),
  keyFindings: z.array(z.object({ text: long, tone })).max(12),
  financialSnapshot: z.object({
    asOf: short,
    currency: z.literal("INR"),
    items: z.array(snapshotItem).max(40),
  }),
  evidenceCards: z.array(evidenceCard).max(20),
  calculations: z.array(calculation).max(20),
  predictions: z.array(prediction).max(10),
  scenarioComparison: scenarioComparison.nullable(),
  recommendations: z.array(recommendation).max(8),
  actionPlan: z.array(z.object({ step: z.number().int().positive(), title: short, detail: long, timeframe: short.optional(), href: short.optional() })).max(12),
  charts: z.array(chart).max(6),
  assumptions: z.array(long).max(20),
  risks: z.array(long).max(12),
  dataGaps: z.array(z.object({ code: short, message: long, impact: long })).max(20),
  followUpSuggestions: z.array(short).max(6),
  executionActions: z.array(executionAction).max(6),
  citations: z
    .array(z.object({ chunkId: short, sourceType: short, title: short, snippet: text(600), confidence: z.enum(["high", "medium", "low"]) }))
    .max(12),
  metadata: z.object({
    version: z.literal(1),
    generatedAt: short,
    engines: z
      .array(
        z.object({
          name: z.enum(["financial_context", "calculations", "ai_search", "scenario", "documents", "explanation"]),
          status: z.enum(["used", "unavailable", "skipped"]),
          detail: long.optional(),
        }),
      )
      .max(10),
    partial: z.boolean(),
    explanationSource: z.enum(["deterministic", "model"]),
    executionMs: finite.nonnegative(),
  }),
}) as unknown as z.ZodType<CoachReportDTO>;

export type ReportValidation = { ok: true; report: CoachReportDTO } | { ok: false; issues: string[] };

/** Validates a candidate report. Never throws; the issues list is bounded and contains paths only, not values. */
export function validateCoachReport(candidate: unknown): ReportValidation {
  const parsed = coachReportSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, report: parsed.data };
  return { ok: false, issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`) };
}

/** A minimal, always-valid report used when a richer one fails validation or a legacy path produced only text. */
export function minimalReport(input: {
  directAnswer: string;
  answerType?: CoachReportDTO["answerType"];
  evidenceSufficiency?: CoachReportDTO["evidenceSufficiency"];
  now?: Date;
  executionMs?: number;
  partial?: boolean;
  dataGaps?: CoachReportDTO["dataGaps"];
}): CoachReportDTO {
  const now = input.now ?? new Date();
  return {
    directAnswer: input.directAnswer.slice(0, 4000) || "No answer could be produced.",
    answerType: input.answerType ?? "legacy",
    evidenceSufficiency: input.evidenceSufficiency ?? "partial",
    keyFindings: [],
    financialSnapshot: { asOf: now.toISOString(), currency: "INR", items: [] },
    evidenceCards: [],
    calculations: [],
    predictions: [],
    scenarioComparison: null,
    recommendations: [],
    actionPlan: [],
    charts: [],
    assumptions: [],
    risks: [],
    dataGaps: input.dataGaps ?? [],
    followUpSuggestions: [],
    executionActions: [],
    citations: [],
    metadata: {
      version: 1,
      generatedAt: now.toISOString(),
      engines: [],
      partial: input.partial ?? false,
      explanationSource: "deterministic",
      executionMs: input.executionMs ?? 0,
    },
  };
}
