import { parseStatementText } from "../src/ai/copilot-ingestion/parsing/statement-parser";

describe("parseStatementText", () => {
  it("parses a common Indian statement line format (DD/MM/YYYY, amount, Dr marker)", () => {
    const { parsed, unparsedLines } = parseStatementText("15/01/2026, POS AMAZON.IN 4829102, 1249.00 Dr");
    expect(unparsedLines).toEqual([]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].amount).toBe(1249);
    expect(parsed[0].date.getFullYear()).toBe(2026);
    expect(parsed[0].date.getMonth()).toBe(0); // January
    expect(parsed[0].date.getDate()).toBe(15);
  });

  it("parses an ISO-style date", () => {
    const { parsed } = parseStatementText("2026-02-03 SWIGGY BANGALORE 450.00");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].date.getFullYear()).toBe(2026);
    expect(parsed[0].date.getMonth()).toBe(1);
    expect(parsed[0].date.getDate()).toBe(3);
  });

  it("parses a 'DD Mon YYYY' date format", () => {
    const { parsed } = parseStatementText("05 Mar 2026 NETFLIX.COM 649.00");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].date.getMonth()).toBe(2); // March
  });

  it("excludes credit ('Cr') lines — this pipeline only imports expenses", () => {
    const { parsed, unparsedLines } = parseStatementText("10/01/2026, SALARY CREDIT, 50000.00 Cr");
    expect(parsed).toEqual([]);
    expect(unparsedLines).toEqual([]); // recognized and intentionally excluded, not "couldn't parse"
  });

  it("puts lines with no date or no amount into unparsedLines rather than dropping them silently", () => {
    const { parsed, unparsedLines } = parseStatementText("Opening balance carried forward\nStatement period: Jan 2026");
    expect(parsed).toEqual([]);
    expect(unparsedLines).toHaveLength(2);
  });

  it("handles multiple lines, mixing parseable and unparseable", () => {
    const text = ["15/01/2026, AMAZON, 1249.00 Dr", "some header line with no date or amount", "16/01/2026, SWIGGY, 350.50 Dr"].join("\n");
    const { parsed, unparsedLines } = parseStatementText(text);
    expect(parsed).toHaveLength(2);
    expect(unparsedLines).toHaveLength(1);
  });

  it("strips the matched date and amount substrings from the merchant description", () => {
    const { parsed } = parseStatementText("15/01/2026, POS AMAZON.IN 4829102, 1249.00 Dr");
    expect(parsed[0].merchantRaw).not.toContain("15/01/2026");
    expect(parsed[0].merchantRaw).not.toContain("1249.00");
  });

  it("ignores blank lines", () => {
    const { parsed, unparsedLines } = parseStatementText("\n\n15/01/2026, AMAZON, 100.00 Dr\n\n");
    expect(parsed).toHaveLength(1);
    expect(unparsedLines).toEqual([]);
  });
});
