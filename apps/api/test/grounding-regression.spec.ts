import { GroundingService, collectGroundableText } from "../src/ai/gateway/grounding.service";

// Regression coverage for the production warning
//   "...failed grounding verification (attempt 1)... figures not present in the given facts: 0,1,2"
// Root cause: the gateway scored JSON.stringify(result), so the serialized `citedIndices:[0,1,2]`
// was read as one invented figure (the number regex also swallowed the commas -> 12).

describe("GroundingService — structural markers are not financial claims", () => {
  const grounding = new GroundingService();
  const context = "Home loan EMI is ₹45,200 per month at 8.5% interest. Outstanding balance: ₹32,50,000 as of 2026-09-30.";

  it("scores user-facing text, not serialized structure (citedIndices no longer look like figures)", () => {
    // The pre-fix extractor matched `0,1,2` in the serialized JSON as a single figure and
    // parsed it as 12, producing the production message "figures not present: 0,1,2".
    const result = { hasEvidence: true, answer: "Your home loan EMI is ₹45,200 per month.", citedIndices: [0, 1, 2] };

    const text = collectGroundableText(result);
    expect(text).toContain("₹45,200");
    expect(text).not.toMatch(/citedIndices|hasEvidence/);
    expect(grounding.score(text, context).unmatchedNumbers).toEqual([]);

    // Defence in depth: even if a caller still scores the raw serialized JSON, the structural
    // array is no longer one invented figure.
    const raw = grounding.score(JSON.stringify(result), context);
    expect(raw.unmatchedNumbers).not.toContain("0,1,2");
  });

  it("does not read a comma-separated list of small integers as one invented figure", () => {
    const scored = grounding.score("Sources used: 0,1,2", "Some unrelated context with ₹5,000.");
    expect(scored.unmatchedNumbers).not.toContain("0,1,2");
    expect(scored.unmatchedNumbers).not.toContain("012");
  });

  it("ignores standalone list numbers at the start of a line", () => {
    const answer = "1. Your EMI is ₹45,200.\n2) Your interest rate is 8.5%.\n- 3. Outstanding is ₹32,50,000.";
    expect(grounding.score(answer, context).unmatchedNumbers).toEqual([]);
  });

  it("ignores bracketed citation markers such as [0] and [1, 3]", () => {
    const answer = "Your EMI is ₹45,200 [0] and the rate is 8.5% [1, 3].";
    expect(grounding.score(answer, context).unmatchedNumbers).toEqual([]);
  });

  it("does not strip digits that are part of a real figure on a list line", () => {
    // "12.5%" and "2.5 lakh" start with digits and a dot but are not list markers.
    const scored = grounding.score("12.5% return on the fund.", "The fund returned 8.5%.");
    expect(scored.unmatchedNumbers).toContain("12.5%");
    const lakh = grounding.score("2.5 lakh saved", "Saved 1 lakh");
    expect(lakh.unmatchedNumbers).toContain("2.5");
  });
});

describe("GroundingService — genuinely unsupported figures are still rejected", () => {
  const grounding = new GroundingService();
  const context =
    "Salary credited ₹1,25,000 on 2026-09-01. SIP of ₹10,000 per month. Savings account balance ₹2,40,500.75. Fund return 12.4% p.a.";

  it("accepts supported INR amounts (Indian and Western grouping), decimals and percentages", () => {
    const answer = "Salary ₹1,25,000; SIP ₹10,000; balance ₹2,40,500.75; return 12.4%.";
    const scored = grounding.score(answer, context);
    expect(scored.unmatchedNumbers).toEqual([]);
    expect(scored.risk).not.toBe("high");
  });

  it("rejects an invented INR amount", () => {
    const scored = grounding.score("Your balance is ₹3,90,000.", context);
    expect(scored.unmatchedNumbers).toContain("3,90,000");
    expect(scored.risk).toBe("high");
  });

  it("rejects an invented percentage and an invented interest rate", () => {
    expect(grounding.score("Your return is 18%.", context).unmatchedNumbers).toContain("18%");
    expect(grounding.score("Your loan rate is 9.75%.", context).unmatchedNumbers).toContain("9.75%");
  });

  it("rejects an invented date component but accepts the supported date", () => {
    expect(grounding.score("Salary arrived on 2026-09-01.", context).unmatchedNumbers).toEqual([]);
    const wrongDate = grounding.score("Salary arrived on 2026-09-17.", context);
    expect(wrongDate.unmatchedNumbers).toContain("17");
  });

  it("does not read dates or ranges as negative numbers", () => {
    const scored = grounding.score("Between 2026-09-01 and 2026-09-30", "Between 2026-09-01 and 2026-09-30");
    expect(scored.unmatchedNumbers).toEqual([]);
    expect(grounding.score("5-10 years", "Horizon of 5 to 10 years").unmatchedNumbers).toEqual([]);
  });

  it("still treats a percent and a bare number with the same digits as different", () => {
    expect(grounding.score("Rate is 5%.", "Rate is 5.").unmatchedNumbers).toContain("5%");
  });

  it("checks figures inside markdown tables", () => {
    const table = "| Item | Amount |\n|---|---|\n| SIP | ₹10,000 |\n| Invented | ₹77,777 |";
    const scored = grounding.score(table, context);
    expect(scored.unmatchedNumbers).toEqual(["77,777"]);
  });

  it("scores a response with missing context as ungrounded when it states figures", () => {
    const scored = grounding.score("Your balance is ₹5,00,000.", "");
    expect(scored.unmatchedNumbers).toContain("5,00,000");
    expect(scored.risk).toBe("high");
  });

  it("tolerates rounding within 1% but not beyond", () => {
    expect(grounding.score("About ₹1,25,500", context).unmatchedNumbers).toEqual([]);
    expect(grounding.score("About ₹1,40,000", context).unmatchedNumbers).toContain("1,40,000");
  });
});

describe("collectGroundableText", () => {
  it("keeps string values and non-structural numbers, drops keys, booleans and indices", () => {
    const text = collectGroundableText({
      hasEvidence: true,
      answer: "EMI ₹45,200",
      citedIndices: [0, 1, 2],
      orderedIndices: [3, 4],
      confidence: 0.9,
      nested: { amount: 5000, note: "ok" },
    });
    expect(text).toContain("EMI ₹45,200");
    expect(text).toContain("5000");
    expect(text).toContain("ok");
    expect(text).not.toContain("hasEvidence");
    expect(text).not.toContain("0.9");
    expect(text.split("\n")).not.toContain("0");
  });

  it("returns an empty string for null, undefined and booleans", () => {
    expect(collectGroundableText(null)).toBe("");
    expect(collectGroundableText(undefined)).toBe("");
    expect(collectGroundableText(true)).toBe("");
  });
});
