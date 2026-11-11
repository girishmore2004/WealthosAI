import { randomUUID } from "crypto";
import { IntentResult, PlannedCall } from "../agent.types";
import { AGENT_MAX_TOOL_CALLS } from "../agent.constants";

// Turns an intent into an ordered list of tool calls. This is plain code and it only ever reads the USER's message: the
// plan never depends on retrieved documents, tool output or memory, so none of those can steer which tools run. (Action
// arguments are filled in separately, from a schema-validated extraction, and then shown to the user for approval.)

const ANOMALY = /\b(anomal|unusual|odd|suspicious|outlier|forecast|predict|projection|risk|drift|trend)/i;
const HISTORY = /\b(history|over time|changed|change in|since (?:last|my)|how has|progress|compared? (?:to|with) (?:last|previous)|previous (?:month|snapshot))\b/i;
const STATEMENT = /\b(statement|upload|import|ingest|ocr|parsed)\b/i;

const call = (tool: string, args: Record<string, unknown>, purpose: string, runIf?: PlannedCall["runIf"]): PlannedCall => ({ callId: randomUUID(), tool, args, purpose, ...(runIf ? { runIf } : {}) });

export function buildExecutionPlan(intent: IntentResult, message: string, opts: { attachmentCount?: number } = {}): PlannedCall[] {
  const q = message.trim().slice(0, 500);
  let plan: PlannedCall[] = [];
  switch (intent.intent) {
    case "financial_analysis":
      plan = [call("financial_engine_answer", { question: q }, "answer from live data")];
      // The engine deliberately hands off some questions (goals, tax, retirement, transactions); the coach answers those.
      plan.push(call("coach_advisor", { question: q }, "fallback when the engine hands off", "previous_unhandled"));
      if (ANOMALY.test(q)) plan.push(call("ml_insights", { focus: /forecast|predict|projection/i.test(q) ? "forecast" : /anomal|unusual|odd|suspicious|outlier/i.test(q) ? "anomalies" : "all" }, "statistical insight"));
      if (HISTORY.test(q)) plan.push(call("financial_history", {}, "compare dated snapshots"));
      break;
    case "document_question":
      plan = [call("rag_search", { query: q }, "search the user's documents")];
      if (STATEMENT.test(q) || (opts.attachmentCount ?? 0) > 0) plan.push(call("statement_ingestion_status", {}, "processing status"));
      break;
    case "planning":
      plan = [call("coach_advisor", { question: q }, "build the plan with the planning agents")];
      break;
    case "scenario_analysis":
      plan = [call("scenario_simulation", { prompt: q }, "deterministic what-if")];
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
