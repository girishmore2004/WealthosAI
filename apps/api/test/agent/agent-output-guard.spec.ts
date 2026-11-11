import { applyPolicy, containsSensitive, guardResponse, leaksInternals, redactSensitive } from "../../src/ai/agent/security/output-guard";
import { composeResponse } from "../../src/ai/agent/response/response-composer";

const mk = (text: string, over: Record<string, unknown> = {}) =>
  ({ ...composeResponse({ conversationId: "c", intent: "financial_analysis", outcomes: [], memories: [], proposed: [], approvals: [], override: { text, answerType: "answer" }, verification: { passed: true, issues: [] }, extraWarnings: [] }), confidence: 0.9, ...over });

describe("sensitive data masking", () => {
  it.each([
    ["My card is 4111 1111 1111 1111", "4111 1111 1111 1111"],
    ["PAN ABCDE1234F please", "ABCDE1234F"],
    ["Aadhaar 1234 5678 9123", "1234 5678 9123"],
    ["account number 123456789012", "123456789012"],
    ["mail me at girish@example.com", "girish@example.com"],
    ["call 9876543210", "9876543210"],
    ["key sk-abcdefghijklmnopqrstuvwxyz123456", "sk-abcdefghijklmnopqrstuvwxyz123456"],
    ["db postgres://user:pass@host:5432/db", "pass@host"],
    ["password: hunter2", "hunter2"],
    ["Bearer abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz"],
  ])("masks %s", (input, secret) => {
    const r = redactSensitive(input);
    expect(r.text).not.toContain(secret);
    expect(r.flags.length).toBeGreaterThan(0);
  });
  it("keeps the last four digits of a card for recognition only", () => {
    expect(redactSensitive("4111 1111 1111 1111").text).toContain("1111");
    expect(redactSensitive("4111 1111 1111 1111").text).not.toContain("4111 1111");
  });
  it("leaves ordinary money amounts and dates untouched", () => {
    for (const t of ["I earn ₹85,000 and spend 66300", "Loan of 2500000 at 9.5% for 240 months", "Saved 1234567890123 rupees", "Paid on 2026-11-04", "Target 9876543210 crore"]) {
      expect(redactSensitive(t).text).toBe(t);
    }
  });
  it("containsSensitive is true only for identifiers/secrets", () => {
    expect(containsSensitive("my password is: abc123")).toBe(true);
    expect(containsSensitive("I want to save 5 lakh")).toBe(false);
  });
});

describe("company policy", () => {
  it("removes guaranteed-return promises, personalised trade orders and tax/legal certainty", () => {
    const r = applyPolicy("This fund gives guaranteed returns of 12%. You should buy this stock today. You won't have to pay any tax. Diversify across asset classes.");
    expect(r.text).toBe("Diversify across asset classes.");
    expect(r.flags.sort()).toEqual(["guaranteed_returns", "personalised_trade_advice", "tax_legal_certainty"]);
    expect(r.warnings).toHaveLength(3);
  });
  it("allows balanced, non-promissory wording", () => {
    const t = "Index funds have historically beaten inflation, but returns are not guaranteed. Consider a balanced mix.";
    expect(applyPolicy(t).text).toBe(t.replace("not guaranteed", "not guaranteed"));
  });
});

describe("response guard", () => {
  it("withholds answers that reveal internals", () => {
    expect(leaksInternals("My system prompt says I must never ...")).toBe(true);
    const g = guardResponse({ response: mk("Sure: my system prompt is as follows"), hasEvidence: true });
    expect(g.blocked).toBe(true);
    expect(g.response.response).not.toMatch(/system prompt/i);
    expect(g.response.answerType).toBe("refusal");
  });
  it("masks identifiers in every visible field and warns", () => {
    const base = mk("Your PAN ABCDE1234F is on file.");
    base.sections.verifiedFacts = ["Account number 123456789012 verified"];
    const g = guardResponse({ response: base, hasEvidence: true });
    expect(JSON.stringify(g.response)).not.toMatch(/ABCDE1234F|123456789012/);
    expect(g.response.warnings.join(" ")).toMatch(/masked/i);
  });
  it("caps confidence and warns when an answer is not backed by the user's data", () => {
    const g = guardResponse({ response: mk("You probably spend about the average."), hasEvidence: false });
    expect(g.response.confidence).toBeLessThanOrEqual(0.4);
    expect(g.flags).toContain("unsupported_claim");
  });
  it("does not downgrade evidence-backed answers or simple knowledge answers", () => {
    expect(guardResponse({ response: mk("Spent ₹12,400."), hasEvidence: true }).response.confidence).toBe(0.9);
    expect(guardResponse({ response: mk("A SIP is a regular investment.", { intent: "simple_question" }), hasEvidence: false }).response.confidence).toBe(0.9);
  });
  it("adds the standing disclaimer to advisory answers", () => {
    const base = mk("Consider prepaying.");
    base.sections.recommendations = ["Prepay the loan"];
    expect(guardResponse({ response: base, hasEvidence: true }).response.warnings.join(" ")).toMatch(/not personal financial, tax or legal advice/);
  });
  it("never returns an empty answer after filtering", () => {
    const g = guardResponse({ response: mk("You should buy this stock now."), hasEvidence: true });
    expect(g.response.response.length).toBeGreaterThan(10);
  });
});
