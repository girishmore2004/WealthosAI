import {
  extractAmountFilter,
  extractDateRange,
  extractNegations,
  hasNoSearchableSubject,
  heuristicPlanFields,
  introducesNoNewFigures,
  rewritePreservesMeaning,
  understandQuery,
} from "../src/ai/rag/retrieval/query-understanding";

const NOW = new Date("2026-10-12T10:00:00Z");

describe("AI Search query understanding — dates", () => {
  it("reads an explicit month and year", () => {
    expect(extractDateRange("groceries in September 2026", NOW)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(extractDateRange("expenses Feb 2028", NOW)).toMatchObject({ from: "2028-02-01", to: "2028-02-29" });
  });
  it("reads ISO dates and ISO months", () => {
    expect(extractDateRange("transactions on 2026-09-12", NOW)).toMatchObject({ from: "2026-09-12", to: "2026-09-12" });
    expect(extractDateRange("income for 2026-09", NOW)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });
  it("resolves relative phrases against the supplied clock only", () => {
    expect(extractDateRange("spend last month", NOW)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(extractDateRange("spend this month", NOW)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(extractDateRange("income last year", NOW)).toMatchObject({ from: "2025-01-01", to: "2025-12-31" });
    expect(extractDateRange("spend in the last 30 days", NOW)).toMatchObject({ to: "2026-10-12", from: "2026-09-12" });
  });
  it("wraps the year boundary for 'last month' in January", () => {
    expect(extractDateRange("spend last month", new Date("2027-01-05T00:00:00Z"))).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
  });
  it("never invents a period: a month with no year, or no period at all, yields nothing", () => {
    expect(extractDateRange("what did I spend in September", NOW)).toBeUndefined();
    expect(extractDateRange("what is my EMI", NOW)).toBeUndefined();
  });
  it("does not read an amount as a year", () => {
    expect(extractDateRange("premium of 2024 rupees", NOW)).toBeUndefined();
  });
});

describe("AI Search query understanding — amounts", () => {
  it("reads comparison cues with Indian digit grouping and units", () => {
    expect(extractAmountFilter("premium above 20,000")).toMatchObject({ min: 20000 });
    expect(extractAmountFilter("loans below 5 lakh")).toMatchObject({ max: 500000 });
    expect(extractAmountFilter("between ₹1,50,000 and ₹2,00,000")).toMatchObject({ min: 150000, max: 200000 });
    expect(extractAmountFilter("at least 1.5 crore")).toMatchObject({ min: 15000000 });
  });
  it("reads a stated exact amount only when it carries a currency or unit", () => {
    expect(extractAmountFilter("payment of Rs. 5000")).toMatchObject({ exact: 5000 });
    expect(extractAmountFilter("a 50k transfer")).toMatchObject({ exact: 50000 });
  });
  it("does not treat a bare number, a year or a count as an amount", () => {
    expect(extractAmountFilter("what happened in 2026")).toBeUndefined();
    expect(extractAmountFilter("my 3 policies")).toBeUndefined();
  });
});

describe("AI Search query understanding — negations, intent, lookup kind", () => {
  it("reports explicit exclusions", () => {
    expect(extractNegations("show expenses excluding rent and dining")).toEqual(["rent", "dining"]);
    expect(extractNegations("expenses excluding rent in 2026-09")).toEqual(["rent"]);
    expect(extractNegations("spending without insurance premiums.")).toEqual(["insurance premiums"]);
    expect(extractNegations("what is my EMI")).toEqual([]);
  });
  it("classifies the main intents", () => {
    const intent = (q: string) => understandQuery(q, NOW).intent;
    expect(intent("what is my home loan EMI")).toBe("loans");
    expect(intent("when does my health insurance renew")).toBe("insurance");
    expect(intent("what does my loan agreement say about foreclosure")).toBe("documents");
    expect(intent("how much is my SIP")).toBe("sips");
    expect(intent("what is my net worth")).toBe("portfolio");
    expect(intent("how much did I spend on groceries")).toBe("expenses");
    expect(intent("what is the weather in Paris")).toBe("general");
  });
  it("separates exact lookups from analytical questions", () => {
    expect(understandQuery("What is my home loan EMI?", NOW).lookupKind).toBe("exact");
    expect(understandQuery("Why has my spending gone up compared to last month?", NOW).lookupKind).toBe("analytical");
    expect(understandQuery("Am I on track for my goals and how should I improve my savings over the next year", NOW).lookupKind).toBe("analytical");
  });
  it("detects named document kinds", () => {
    expect(understandQuery("what does my loan agreement say", NOW).documentTypeHints).toContain("loan agreement");
  });
});

describe("AI Search query understanding — ambiguity", () => {
  it("asks for clarification when the question names no subject", () => {
    for (const q of ["what about it?", "and the same for last month?", "tell me more", "ok thanks"]) {
      expect(hasNoSearchableSubject(q)).toBe(true);
      expect(understandQuery(q, NOW).needsClarification).toBe(true);
    }
  });
  it("does not ask for clarification when a subject or a figure is present", () => {
    for (const q of ["what is my EMI", "net worth?", "premium 18500"]) {
      expect(understandQuery(q, NOW).needsClarification).toBe(false);
    }
  });
});

describe("AI Search rewrite safety", () => {
  it("accepts a rewrite that keeps every figure and negation", () => {
    expect(rewritePreservesMeaning("expenses above 20,000 in 2026-09 excluding rent", "spending over 20000 for 2026-09 excluding rent")).toBe(true);
  });
  it("rejects a rewrite that drops or changes a figure", () => {
    expect(rewritePreservesMeaning("premium above 20,000", "premium above 2,000")).toBe(false);
    expect(rewritePreservesMeaning("spend in September 2026", "spend in September")).toBe(false);
  });
  it("rejects a rewrite that drops or introduces a negation", () => {
    expect(rewritePreservesMeaning("expenses excluding rent", "expenses including rent")).toBe(false);
    expect(rewritePreservesMeaning("my loan emi", "my loan emi not paid")).toBe(false);
  });
  it("sub-questions may drop figures but never introduce one", () => {
    expect(introducesNoNewFigures("compare 2026-09 with 2026-08", "expenses in 2026-09")).toBe(true);
    expect(introducesNoNewFigures("compare 2026-09 with 2026-08", "expenses in 2026-07")).toBe(false);
  });
});

describe("AI Search heuristic plan (model unavailable)", () => {
  it("no longer defaults every question to exploratory", () => {
    const f = (q: string) => heuristicPlanFields(q, understandQuery(q, NOW));
    expect(f("What is my home loan EMI?")).toEqual({ queryType: "factual", complexity: "simple" });
    expect(f("Compare my expenses in September 2026 with August 2026").queryType).toBe("comparative");
    expect(f("Compare my expenses in September 2026 with August 2026").complexity).toBe("complex");
    expect(f("tell me something interesting").queryType).toBe("exploratory");
  });
});
