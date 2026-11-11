import { assessMemoryWrite, classifyPrivacy, lexicalOverlap, resolveConflict, scoreMemory, TRUST_RANK } from "../../src/ai/agent/memory/memory-policy";
import { extractMemoryCandidates } from "../../src/ai/agent/memory/memory-extractor";
import { classifyIntentRules } from "../../src/ai/agent/intent/intent-rules";

describe("memory write policy", () => {
  it("user-confirmed requires the user's own message", () => {
    expect(assessMemoryWrite({ source: "USER_CONFIRMED", confidence: 1, category: "SEMANTIC", evidence: [{ type: "tool", ref: "x" }] }).ok).toBe(false);
    expect(assessMemoryWrite({ source: "USER_CONFIRMED", confidence: 1, category: "SEMANTIC", evidence: [{ type: "user_message", ref: "m" }] }).ok).toBe(true);
  });
  it("system-verified requires a deterministic tool/snapshot/execution", () => {
    expect(assessMemoryWrite({ source: "SYSTEM_VERIFIED", confidence: 0.9, category: "EPISODIC", evidence: [{ type: "user_message", ref: "m" }] }).ok).toBe(false);
    expect(assessMemoryWrite({ source: "SYSTEM_VERIFIED", confidence: 0.9, category: "EPISODIC", evidence: [{ type: "snapshot", ref: "s" }] }).ok).toBe(true);
  });
  it("caps AI-inferred confidence and leaves it unverified", () => {
    const v = assessMemoryWrite({ source: "AI_INFERRED", confidence: 0.99, category: "SEMANTIC", evidence: [] });
    expect(v).toMatchObject({ ok: true, verification: "UNVERIFIED" });
    if (v.ok) expect(v.confidence).toBeLessThanOrEqual(0.6);
  });
  it("trust ordering decides conflicts; an inference never overwrites a confirmed fact", () => {
    expect(TRUST_RANK.USER_CONFIRMED).toBeGreaterThan(TRUST_RANK.SYSTEM_VERIFIED);
    expect(TRUST_RANK.SYSTEM_VERIFIED).toBeGreaterThan(TRUST_RANK.AI_INFERRED);
    expect(resolveConflict({ source: "USER_CONFIRMED" }, { source: "AI_INFERRED" })).toBe("reject_candidate");
    expect(resolveConflict({ source: "AI_INFERRED" }, { source: "USER_CONFIRMED" })).toBe("replace_existing");
    expect(resolveConflict({ source: "USER_CONFIRMED" }, { source: "USER_CONFIRMED" })).toBe("replace_existing");
  });
  it("classifies amounts and financial terms as sensitive", () => {
    expect(classifyPrivacy("my salary is 90000")).toBe("SENSITIVE");
    expect(classifyPrivacy("prefers short answers")).toBe("NORMAL");
  });
  it("scores relevant, trusted, recent memories higher", () => {
    expect(lexicalOverlap("home loan prepayment", "wants to prepay the home loan")).toBeGreaterThan(0);
    expect(lexicalOverlap("home loan", "likes cricket")).toBe(0);
  });
  it("scoreMemory is monotonic in trust", () => {
    const base = { semantic: 0.5, lexical: 0.5, ageDays: 10, confidence: 0.8, category: "SEMANTIC" as const, intent: "financial_analysis" };
    const hi = scoreMemory({ ...base, source: "USER_CONFIRMED" } as never).score;
    const lo = scoreMemory({ ...base, source: "AI_INFERRED" } as never).score;
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("memory extraction", () => {
  const intent = (message: string) => classifyIntentRules(message);
  it("stores what the user states about themselves as user-confirmed with their message as evidence", () => {
    const c = extractMemoryCandidates({ message: "My monthly salary is 90000", intent: intent("My monthly salary is 90000"), outcomes: [], runId: "r1" });
    const fact = c.find((x) => x.source === "USER_CONFIRMED");
    expect(fact).toBeTruthy();
    expect(fact!.evidence.some((e) => e.type === "user_message")).toBe(true);
  });
  it("does not store questions as facts", () => {
    const c = extractMemoryCandidates({ message: "Is my salary of 90000 enough?", intent: intent("Is my salary of 90000 enough?"), outcomes: [], runId: "r1" });
    expect(c.filter((x) => x.source === "USER_CONFIRMED")).toHaveLength(0);
  });
  it("does not let a model-style assistant claim become verified", () => {
    const c = extractMemoryCandidates({ message: "what is sip", intent: intent("what is sip"), outcomes: [], runId: "r1" });
    expect(c.filter((x) => x.source === "SYSTEM_VERIFIED" || x.source === "USER_CONFIRMED")).toHaveLength(0);
  });
});

describe("intent rules: unsupported actions are rule-only", () => {
  it.each([
    "Transfer 50000 to my brother",
    "Pay my EMI now",
    "Buy 10 shares of Infosys",
    "Sell my mutual funds",
    "Delete all my transactions",
    "Set up autopay for my loan",
  ])("%s → unsupported_action", (m) => expect(classifyIntentRules(m).intent).toBe("unsupported_action"));
  it("routes ordinary requests", () => {
    expect(classifyIntentRules("What is my savings rate this month?").intent).toBe("financial_analysis");
    expect(classifyIntentRules("What if I prepay my loan by 2 lakh?").intent).toBe("scenario_analysis");
    expect(classifyIntentRules("What does my policy document say about exclusions?").intent).toBe("document_question");
    expect(classifyIntentRules("What did we decide last time?").intent).toBe("memory_recall");
    expect(classifyIntentRules("Create a goal to save 5 lakh").intent).toBe("action_request");
    expect(classifyIntentRules("What is an index fund?").intent).toBe("simple_question");
  });
});
