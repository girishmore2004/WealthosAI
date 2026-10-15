import {
  CoachActionStepDTO,
  CoachCalculationDTO,
  CoachChartDTO,
  CoachCitationDTO,
  CoachDataGapDTO,
  CoachDataQuality,
  CoachEngineStatusDTO,
  CoachEvidenceCardDTO,
  CoachExecutionActionDTO,
  CoachFindingDTO,
  CoachPredictionDTO,
  CoachRecommendationDTO,
  CoachReportDTO,
  CoachScenarioComparisonDTO,
  CoachSnapshotItemDTO,
  CoachTone,
} from "@wealthos/types";
import { formatINR } from "../../../common/utils/currency.util";
import { minimalReport, validateCoachReport } from "./coach-report.schema";

// Collects the parts of one Coach report and validates the whole before it leaves the server. Handlers only
// add deterministic, already-computed values here; nothing in this class calls a model or does arithmetic.

export const inr = (n: number): string => formatINR(n);
export const signedInr = (n: number): string => `${n < 0 ? "−" : "+"}${formatINR(Math.abs(n))}`;
export const pct = (n: number): string => `${n}%`;

/** Collapses whitespace, removes control characters and bounds length. Used on any text that did not come from our own code. */
export function cleanText(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

export class ReportBuilder {
  readonly findings: CoachFindingDTO[] = [];
  readonly snapshot: CoachSnapshotItemDTO[] = [];
  readonly evidence: CoachEvidenceCardDTO[] = [];
  readonly calculations: CoachCalculationDTO[] = [];
  readonly predictions: CoachPredictionDTO[] = [];
  scenario: CoachScenarioComparisonDTO | null = null;
  recommendations: CoachRecommendationDTO[] = [];
  readonly actionPlan: CoachActionStepDTO[] = [];
  readonly charts: CoachChartDTO[] = [];
  readonly assumptions: string[] = [];
  readonly risks: string[] = [];
  readonly dataGaps: CoachDataGapDTO[] = [];
  readonly followUps: string[] = [];
  readonly actions: CoachExecutionActionDTO[] = [];
  readonly citations: CoachCitationDTO[] = [];
  private readonly engines = new Map<CoachEngineStatusDTO["name"], CoachEngineStatusDTO>();
  partial = false;

  constructor(private readonly now: Date, private readonly startedAt: number = Date.now()) {}

  finding(text: string, tone: CoachTone = "info"): this {
    this.findings.push({ text, tone });
    return this;
  }

  item(key: string, label: string, value: number | null, display: string, unit: CoachSnapshotItemDTO["unit"], quality: CoachDataQuality, note?: string): this {
    this.snapshot.push({ key, label, value, display, unit, quality, ...(note ? { note } : {}) });
    return this;
  }

  /** A money figure. A null value is shown as "Not recorded" and is never turned into 0. */
  money(key: string, label: string, value: number | null, quality: CoachDataQuality = "verified", note?: string): this {
    return this.item(key, label, value, value === null ? "Not recorded" : inr(value), "INR", value === null ? "missing" : quality, note);
  }

  assume(text: string): this {
    if (!this.assumptions.includes(text)) this.assumptions.push(text);
    return this;
  }

  risk(text: string): this {
    if (!this.risks.includes(text)) this.risks.push(text);
    return this;
  }

  gap(code: string, message: string, impact: string): this {
    if (!this.dataGaps.some((g) => g.code === code && g.message === message)) this.dataGaps.push({ code, message, impact });
    return this;
  }

  followUp(text: string): this {
    if (this.followUps.length < 6 && !this.followUps.includes(text)) this.followUps.push(text);
    return this;
  }

  step(title: string, detail: string, extra: { timeframe?: string; href?: string } = {}): this {
    this.actionPlan.push({ step: this.actionPlan.length + 1, title, detail, ...extra });
    return this;
  }

  engine(name: CoachEngineStatusDTO["name"], status: CoachEngineStatusDTO["status"], detail?: string): this {
    this.engines.set(name, { name, status, ...(detail ? { detail: detail.slice(0, 400) } : {}) });
    return this;
  }

  open(label: string, href: string, description: string): this {
    this.actions.push({ id: `open-${this.actions.length + 1}`, kind: "OPEN", label, description, href, requiresConfirmation: false });
    return this;
  }

  /** Records every failed context source as a data gap and flags the report as partial. */
  noteSessionFailures(notes: { source: string; ok: boolean; reason?: string }[]): this {
    const failed = notes.filter((n) => !n.ok);
    for (const f of failed) {
      this.gap("SOURCE_UNAVAILABLE", `${f.source} could not be read (${f.reason ?? "unknown error"}).`, "Anything that depends on it is left out or marked as not available, not estimated.");
    }
    this.engine(
      "financial_context",
      notes.length === 0 ? "skipped" : failed.length === 0 ? "used" : "unavailable",
      failed.length ? `Unavailable: ${[...new Set(failed.map((f) => f.source))].join(", ")}` : undefined,
    );
    if (failed.length) this.partial = true;
    return this;
  }

  build(input: { directAnswer: string; answerType: CoachReportDTO["answerType"]; sufficiency: CoachReportDTO["evidenceSufficiency"] }): CoachReportDTO {
    if (!this.engines.has("calculations")) this.engine("calculations", "used");
    const executionMs = Math.max(0, Date.now() - this.startedAt);
    const candidate: CoachReportDTO = {
      directAnswer: input.directAnswer,
      answerType: input.answerType,
      evidenceSufficiency: this.partial && input.sufficiency === "sufficient" ? "partial" : input.sufficiency,
      keyFindings: this.findings,
      financialSnapshot: { asOf: this.now.toISOString(), currency: "INR", items: this.snapshot },
      evidenceCards: this.evidence,
      calculations: this.calculations,
      predictions: this.predictions,
      scenarioComparison: this.scenario,
      recommendations: this.recommendations,
      actionPlan: this.actionPlan,
      charts: this.charts,
      assumptions: this.assumptions,
      risks: this.risks,
      dataGaps: this.dataGaps,
      followUpSuggestions: this.followUps,
      executionActions: this.actions,
      citations: this.citations,
      metadata: {
        version: 1,
        generatedAt: this.now.toISOString(),
        engines: [...this.engines.values()],
        partial: this.partial,
        explanationSource: "deterministic",
        executionMs,
      },
    };
    const validated = validateCoachReport(candidate);
    if (validated.ok) return validated.report;
    // A builder bug must never reach the user as a broken card: fall back to the one thing that is always valid.
    return minimalReport({
      directAnswer: input.directAnswer,
      answerType: input.answerType,
      evidenceSufficiency: "partial",
      now: this.now,
      executionMs,
      partial: true,
      dataGaps: [{ code: "REPORT_INVALID", message: "The detailed breakdown could not be built for this answer.", impact: "Only the direct answer is shown." }],
    });
  }
}

/** A compact plain-text rendering of a report, used as the ONLY facts a model may word an explanation from. */
export function reportToFactsText(r: CoachReportDTO): string {
  const lines: string[] = [`ANSWER: ${r.directAnswer}`];
  for (const f of r.keyFindings) lines.push(`FINDING: ${f.text}`);
  for (const c of r.calculations) lines.push(`CALCULATION: ${c.label} = ${c.display} (${c.formula})`);
  for (const p of r.predictions) lines.push(`PROJECTION: ${p.label} = ${p.display} over ${p.horizon}`);
  if (r.scenarioComparison) for (const row of r.scenarioComparison.rows) lines.push(`SCENARIO: ${row.metric}: ${row.baseline} -> ${row.proposed} (${row.delta})`);
  for (const rec of r.recommendations) lines.push(`RECOMMENDATION ${rec.rank}: ${rec.title} - ${rec.nextStep}`);
  for (const a of r.assumptions) lines.push(`ASSUMPTION: ${a}`);
  for (const g of r.dataGaps) lines.push(`MISSING: ${g.message}`);
  return lines.join("\n");
}
