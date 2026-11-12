import { randomUUID } from "crypto";
import { IntentResult, PlannedCall } from "../agent.types";
import { AGENT_MAX_TOOL_CALLS } from "../agent.constants";
import { decomposeScenarioPrompt } from "../../scenario-studio/compound/compound-scenario";

// Turns an intent into an ordered list of tool calls. This is plain code and it only ever reads the USER's message: the
// plan never depends on retrieved documents, tool output or memory, so none of those can steer which tools run. (Action
// arguments are filled in separately, from a schema-validated extraction, and then shown to the user for approval.)

const ANOMALY = /\b(anomal|unusual|odd|suspicious|outlier|forecast|predict|projection|risk|drift|trend)/i;
const HISTORY = /\b(history|over time|changed|change in|since (?:last|my)|how has|progress|compared? (?:to|with) (?:last|previous)|previous (?:month|snapshot))\b/i;
const STATEMENT = /\b(statement|upload|import|ingest|ocr|parsed)\b/i;

// Financial domains a single message can ask about. A message naming several of them is a multi-domain request: the old
// planner handed it to the finance engine, whose router takes the FIRST matching intent, so a long list that happened to
// include "insurance" was answered with insurance alone.
const DOMAIN_WORDS: Record<string, RegExp> = {
  income: /\b(income|salary|earnings?)\b/i,
  expenses: /\b(expenses?|spending|spent)\b/i,
  transactions: /\btransactions?\b/i,
  savings: /\b(savings?|emergency fund)\b/i,
  investments: /\b(investments?|portfolio|holdings?)\b/i,
  sips: /\bsips?\b/i,
  loans: /\b(loans?|emis?|debts?)\b/i,
  insurance: /\b(insurance|polic(?:y|ies)|premiums?)\b/i,
  goals: /\bgoals?\b/i,
  recurring: /\b(recurring|subscriptions?|bills)\b/i,
};
const COMPREHENSIVE = /\b(complete|full|comprehensive|entire|overall|whole|end[- ]to[- ]end|everything|financial (?:audit|review|health(?: check)?|overview|picture|position))\b/i;
const SPENDING_INTEL = /\b(anomal\w*|unusual (?:spending|expenses?|transactions?)|unnecessary|avoidable|wasteful|overspend\w*|cash[- ]?flow problems?|spending (?:analysis|patterns?|habits)|opportunit\w* to (?:improve )?(?:save|savings)|where (?:is|does) my money go)/i;
const GENERAL_IMPROVEMENT = /\b(improvement plan|improve my (?:finances|financial)|prioriti[sz]ed|measurable targets?|financial (?:action )?plan|action plan|get my finances|fix my finances)\b/i;
const DOC_COMPARE = /\b(compare|reconcile|conflicts?|differences?|mismatch\w*|disagree\w*)\b[^.?!]{0,80}\b(documents?|uploaded|statements?|files?)\b/i;

export const countDomains = (q: string): number => Object.values(DOMAIN_WORDS).filter((r) => r.test(q)).length;

const call = (tool: string, args: Record<string, unknown>, purpose: string, runIf?: PlannedCall["runIf"]): PlannedCall => ({ callId: randomUUID(), tool, args, purpose, ...(runIf ? { runIf } : {}) });

export function buildExecutionPlan(intent: IntentResult, message: string, opts: { attachmentCount?: number } = {}): PlannedCall[] {
  const q = message.trim().slice(0, 500);
  let plan: PlannedCall[] = [];
  switch (intent.intent) {
    case "financial_analysis":
      if (COMPREHENSIVE.test(q) || countDomains(q) >= 4) {
        plan = [call("financial_audit", {}, "retrieve every financial domain in parallel and report per-domain status")];
        break;
      }
      if (SPENDING_INTEL.test(q)) {
        plan = [call("spending_intelligence", {}, "evidence-backed spending, anomaly and savings analysis")];
        if (HISTORY.test(q)) plan.push(call("financial_history", {}, "compare dated snapshots"));
        break;
      }
      plan = [call("financial_engine_answer", { question: q }, "answer from live data")];
      // The engine deliberately hands off some questions (goals, tax, retirement, transactions); the coach answers those.
      plan.push(call("coach_advisor", { question: q }, "fallback when the engine hands off", "previous_unhandled"));
      if (ANOMALY.test(q)) plan.push(call("ml_insights", { focus: /forecast|predict|projection/i.test(q) ? "forecast" : /anomal|unusual|odd|suspicious|outlier/i.test(q) ? "anomalies" : "all" }, "statistical insight"));
      if (HISTORY.test(q)) plan.push(call("financial_history", {}, "compare dated snapshots"));
      break;
    case "document_question":
      if (DOC_COMPARE.test(q)) {
        plan = [call("document_conflicts", {}, "list differences between account records and extracted document values")];
        break;
      }
      plan = [call("rag_search", { query: q }, "search the user's documents")];
      if (STATEMENT.test(q) || (opts.attachmentCount ?? 0) > 0) plan.push(call("statement_ingestion_status", {}, "processing status"));
      break;
    case "planning":
      if (GENERAL_IMPROVEMENT.test(q)) {
        plan = [call("financial_improvement_plan", {}, "account-based prioritised recommendations (nothing is saved)")];
        break;
      }
      plan = [call("coach_advisor", { question: q }, "build the plan with the planning agents")];
      break;
    case "scenario_analysis":
      plan = decomposeScenarioPrompt(q).compound
        ? [call("compound_scenario", { prompt: q }, "independent what-if for each scenario, a combined run and a long-term comparison")]
        : [call("scenario_simulation", { prompt: q }, "deterministic what-if")];
      break;
    case "memory_recall":
      if (HISTORY.test(q)) plan = [call("financial_history", {}, "compare dated snapshots")];
      break;
    case "action_request":
    case "simple_question":
    case "unsupported_action":
    case "clarification":
      break; // action calls are added after argument extraction; the rest need no tools
  }
  return plan.slice(0, AGENT_MAX_TOOL_CALLS);
}
