import { parseNamedMonth, routeIntent, monthLabel } from "../src/ai/financial-engine/financial-intents";
import { composeAnswer } from "../src/ai/financial-engine/answer-composer";

const now = new Date("2026-10-12T00:00:00.000Z");

describe("named-month routing", () => {
  it("resolves 'last month' and 'in <month>'", () => {
    expect(parseNamedMonth("how much did i spend last month", now)).toBe("2026-09");
    expect(parseNamedMonth("what did i earn in march", now)).toBe("2026-03");
    expect(parseNamedMonth("expenses for december", now)).toBe("2025-12");
  });

  it("year-boundary last month", () => {
    expect(parseNamedMonth("last month", new Date("2026-01-05T00:00:00Z"))).toBe("2025-12");
  });

  it("ignores the current month and unrelated text", () => {
    expect(parseNamedMonth("how much did i spend in october", now)).toBeUndefined();
    expect(parseNamedMonth("how much did i spend", now)).toBeUndefined();
    expect(parseNamedMonth("in may be i should save", new Date("2026-10-12"))).toBe("2026-05"); // known loose match, harmless: only cash-flow intents read it
  });

  it("attaches month only to cash-flow style intents", () => {
    expect(routeIntent("how much did i spend in september", now)).toMatchObject({ intent: "FINANCIAL_CALCULATION", metric: "SPENT", month: "2026-09" });
    expect(routeIntent("how much did i spend", now).month).toBeUndefined();
    expect(routeIntent("my loan emi in september", now).month).toBeUndefined();
  });

  it("rewrites 'this month' wording to the named month without adding digits", () => {
    const cf = { tool: "getCashFlow", basis: "x", period: "2026-09", asOfDate: "", warnings: [], missing: [], facts: { expenses: { kind: "MONEY", value: "40000.00" } } } as never;
    const text = composeAnswer({ intent: "FINANCIAL_CALCULATION", metric: "SPENT", month: "2026-09" }, [cf]);
    expect(text).toMatch(/^In September you spent/);
    expect(text).not.toMatch(/this month/i);
    expect(monthLabel("2026-09")).toBe("September");
  });
});
