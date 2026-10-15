import type { AgenticCoachRunDTO, CoachReportDTO } from "@wealthos/types";

/** One question and its answer in the chat. `report` is null for older history rows that predate structured answers. */
export interface ChatTurn {
  id: string;
  question: string;
  answer: string;
  report: CoachReportDTO | null;
  createdAt: string;
  staleAdviceNote?: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored report rides inside the run's facts. Anything that does not look like a report is ignored, never rendered. */
export function reportFromFacts(facts: unknown): CoachReportDTO | null {
  if (!isObject(facts)) return null;
  const r = facts.__report;
  if (!isObject(r) || typeof r.directAnswer !== "string" || !isObject(r.metadata) || r.metadata.version !== 1) return null;
  if (!Array.isArray(r.keyFindings) || !Array.isArray(r.calculations) || !isObject(r.financialSnapshot)) return null;
  return r as unknown as CoachReportDTO;
}

export function turnFromRun(run: AgenticCoachRunDTO): ChatTurn {
  return { id: run.id, question: run.question, answer: run.answer, report: reportFromFacts(run.facts), createdAt: run.createdAt, staleAdviceNote: run.staleAdviceNote };
}

/** Only in-app paths are followed. An absolute or protocol-relative URL is never turned into a link. */
export function safeInternalHref(href: string | undefined | null): string | null {
  if (!href) return null;
  return /^\/(?!\/)[A-Za-z0-9\-_/?=&%.#]*$/.test(href) ? href : null;
}

export const TONE_CLASS: Record<string, string> = {
  good: "text-gain",
  warn: "text-warn",
  bad: "text-loss",
  info: "text-ink-soft",
};

export const QUALITY_LABEL: Record<string, string> = {
  verified: "Verified",
  verified_zero: "Verified zero",
  missing: "Not recorded",
  empty: "No records",
  failed_source: "Unavailable",
  stale: "May be out of date",
  conflicting: "Conflicting",
  incomplete_period: "Period not finished",
  estimate: "Estimate",
  document_extraction: "From document text",
};

export const SUFFICIENCY_LABEL: Record<string, { label: string; className: string }> = {
  sufficient: { label: "Complete data", className: "badge badge-success" },
  partial: { label: "Partial data", className: "badge badge-warning" },
  insufficient: { label: "Not enough data", className: "badge badge-critical" },
};

export const EXAMPLE_QUESTIONS = [
  "What is my savings rate last month?",
  "How much did I spend on food last month?",
  "Am I financially healthy?",
  "Is my emergency fund enough?",
  "Am I on track for retirement?",
  "What if I increase my SIP by ₹5,000?",
  "Can I afford a house worth ₹60 lakh?",
  "Should I prepay my loan or invest in a SIP?",
  "How can I reach my goals faster?",
  "Create a plan to save ₹5 lakh in 24 months",
];
