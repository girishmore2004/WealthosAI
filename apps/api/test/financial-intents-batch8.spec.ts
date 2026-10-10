import { routeIntent } from "../src/ai/financial-engine/financial-intents";
import { verifyAnswer } from "../src/ai/financial-engine/numeric-verifier";

describe("intent router — Batch 8 intents", () => {
  it.each([
    ["How much money do people owe me?", "RECEIVABLES"],
    ["Who owes me money?", "RECEIVABLES"],
    ["What is my daily average spending?", "EXPENSE_BREAKDOWN"],
    ["Which category increased compared to last month?", "EXPENSE_BREAKDOWN"],
    ["What is my top spending category?", "EXPENSE_BREAKDOWN"],
    ["How is my emergency fund doing?", "EMERGENCY_FUND"],
    ["How much is my EMI?", "LOAN"],
  ])("routes %s to %s", (q, intent) => {
    expect(routeIntent(q).intent).toBe(intent);
  });

  it("routes SIP projections with the horizon and the stated return", () => {
    expect(routeIntent("What will my SIP become in 10 years?")).toEqual({ intent: "INVESTMENT_PROJECTION", projection: { years: 10, annualReturn: null } });
    expect(routeIntent("how much will my investments be worth after 15 years at 12%")).toEqual({
      intent: "INVESTMENT_PROJECTION",
      projection: { years: 15, annualReturn: "12" },
    });
  });

  it("still treats a what-if about the SIP as a scenario, not a projection", () => {
    expect(routeIntent("What happens if I increase my SIP by ₹5,000 for 10 years?").intent).toBe("SCENARIO");
  });

  it("marks 'this year' spending and investing questions as yearly", () => {
    expect(routeIntent("How much did I spend this year?")).toEqual({ intent: "FINANCIAL_CALCULATION", metric: "SPENT", span: "YEAR" });
    expect(routeIntent("How much did I invest this month?")).toEqual({ intent: "FINANCIAL_CALCULATION", metric: "INVESTED" });
  });
});

describe("numeric verifier — signed percentages", () => {
  const tool = (change: string) => ({
    tool: "t", basis: "ACTUAL" as const, period: "MONTHLY" as const, asOfDate: "x", facts: { change: { kind: "RATIO" as const, value: change } }, warnings: [], missing: [],
  });
  it("accepts '12.5% lower' for a -0.125 change but still rejects an invented percentage", () => {
    expect(verifyAnswer("Spending was 12.5% lower.", [tool("-0.125")]).passed).toBe(true);
    expect(verifyAnswer("Spending was 13% lower.", [tool("-0.125")]).passed).toBe(false);
  });
  it("still catches a ratio multiplied by 100 twice", () => {
    expect(verifyAnswer("Spending was 1250% higher.", [tool("0.125")]).issues[0].code).toBe("DOUBLE_PERCENT_SCALE");
  });
});
