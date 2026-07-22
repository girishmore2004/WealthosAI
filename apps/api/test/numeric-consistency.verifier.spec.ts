import { NumericConsistencyVerifier } from "../src/ai/coach/verification/numeric-consistency.verifier";

describe("NumericConsistencyVerifier", () => {
  const verifier = new NumericConsistencyVerifier();

  it("passes when every number in the composed answer appears in the facts", () => {
    const facts = "Monthly income: ₹1,20,000. Monthly expenses: ₹68,400. Savings rate: 43%.";
    const composed = "You're earning ₹1,20,000 a month and spending ₹68,400, giving you a savings rate of 43%.";
    const result = verifier.verify(composed, facts);
    expect(result.passed).toBe(true);
    expect(result.unmatchedNumbers).toEqual([]);
  });

  it("fails when the composed answer introduces a number not present in the facts", () => {
    const facts = "Monthly income: ₹1,20,000. Monthly expenses: ₹68,400.";
    const composed = "You're earning ₹1,20,000 a month, and if you invested it at 15% annual return you'd do well.";
    const result = verifier.verify(composed, facts);
    expect(result.passed).toBe(false);
    expect(result.unmatchedNumbers.some((n) => n.includes("15"))).toBe(true);
  });

  it("allows small rounding differences in currency amounts (1% relative tolerance)", () => {
    const facts = "Net worth: ₹42,18,000.";
    const composed = "Your net worth is approximately ₹42,17,650."; // within 1% of 4218000
    const result = verifier.verify(composed, facts);
    expect(result.passed).toBe(true);
  });

  it("rejects a currency amount outside the tolerance", () => {
    const facts = "Net worth: ₹42,18,000.";
    const composed = "Your net worth is approximately ₹50,00,000.";
    const result = verifier.verify(composed, facts);
    expect(result.passed).toBe(false);
  });

  it("allows small rounding differences in percentages (0.15 absolute tolerance)", () => {
    const facts = "Savings rate: 42.9%.";
    const composed = "Your savings rate is about 43%.";
    const result = verifier.verify(composed, facts);
    expect(result.passed).toBe(true);
  });

  it("treats a percentage and a plain number with the same value as different (percent sign matters)", () => {
    const facts = "You have 3 goals.";
    const composed = "Your savings rate is 3%.";
    const result = verifier.verify(composed, facts);
    expect(result.passed).toBe(false);
  });

  it("passes trivially when the composed answer contains no numbers at all", () => {
    const facts = "Monthly income: ₹1,20,000.";
    const composed = "Your income situation looks stable this month.";
    expect(verifier.verify(composed, facts).passed).toBe(true);
  });

  it("ignores zero as a false-positive-prone match", () => {
    const facts = "Monthly income: ₹1,20,000.";
    const composed = "You have 0 issues to worry about today, earning ₹1,20,000.";
    expect(verifier.verify(composed, facts).passed).toBe(true);
  });
});
