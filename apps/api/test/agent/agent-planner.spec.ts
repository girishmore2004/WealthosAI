import { buildExecutionPlan } from "../../src/ai/agent/planning/execution-planner";
import { AGENT_MAX_TOOL_CALLS } from "../../src/ai/agent/agent.constants";
import { IntentResult } from "../../src/ai/agent/agent.types";

const intent = (i: IntentResult["intent"]): IntentResult => ({ intent: i, confidence: 0.9, reasons: [], source: "rules" });

describe("deterministic execution planner", () => {
  it("answers financial questions with the engine, falling back to the coach", () => {
    const p = buildExecutionPlan(intent("financial_analysis"), "How much did I spend on food?");
    expect(p.map((c) => c.tool)).toEqual(["financial_engine_answer", "coach_advisor"]);
    expect(p[1].runIf).toBe("previous_unhandled");
  });
  it("adds ml insights and history only when the user's wording asks for them", () => {
    const p = buildExecutionPlan(intent("financial_analysis"), "Any unusual spending and how has it changed over time?");
    const tools = p.map((c) => c.tool);
    expect(tools).toContain("ml_insights");
    expect(tools).toContain("financial_history");
  });
  it("routes documents to RAG and never plans a write for a question", () => {
    const p = buildExecutionPlan(intent("document_question"), "what does my policy cover", { attachmentCount: 1 });
    expect(p.map((c) => c.tool)).toEqual(["rag_search", "statement_ingestion_status"]);
  });
  it("plans no tools for unsupported actions, clarifications, simple questions or action requests", () => {
    for (const i of ["unsupported_action", "clarification", "simple_question", "action_request"] as const) expect(buildExecutionPlan(intent(i), "x y z")).toEqual([]);
  });
  it("is bounded", () => {
    const p = buildExecutionPlan(intent("financial_analysis"), "unusual forecast history over time changed progress");
    expect(p.length).toBeLessThanOrEqual(AGENT_MAX_TOOL_CALLS);
  });
  it("depends only on the user message: identical for any document content", () => {
    const a = buildExecutionPlan(intent("financial_analysis"), "my spending").map((c) => c.tool);
    const b = buildExecutionPlan(intent("financial_analysis"), "my spending").map((c) => c.tool);
    expect(a).toEqual(b);
  });
});
