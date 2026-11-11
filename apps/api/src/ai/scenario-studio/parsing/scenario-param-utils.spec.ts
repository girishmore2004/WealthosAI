import {
  extractPrimaryParams,
  extractPromptNumbers,
  sanitizeScenarioParams,
} from "./scenario-param-utils";

describe("Scenario parameter extraction", () => {
  const prompt =
    "Increase my salary by 15%, reduce my expenses by 20%, and increase my SIP by ₹5,000 per month.";

  it("extracts the salary increase percentage", () => {
    expect(extractPrimaryParams("SALARY_HIKE", prompt)).toEqual({
      percentIncrease: 15,
    });
  });

  it("extracts the expense reduction percentage", () => {
    expect(
      extractPrimaryParams("EXPENSE_REDUCTION", prompt),
    ).toEqual({
      percentDecrease: 20,
    });
  });

  it("does not confuse the salary percentage with expense reduction", () => {
    const result = sanitizeScenarioParams(
      "EXPENSE_REDUCTION",
      { percentDecrease: 15 },
      prompt,
    );

    expect(result.params).toEqual({});
    expect(result.dropped).toContain("percentDecrease");
  });

  it("extracts an explicitly stated SIP amount", () => {
    expect(
      extractPrimaryParams("SIP_INCREASE", prompt),
    ).toEqual({
      additionalMonthlyAmount: 5000,
    });
  });

  it("does not invent a SIP amount when none is provided", () => {
    expect(
      extractPrimaryParams(
        "SIP_INCREASE",
        "Increase my monthly SIP contribution.",
      ),
    ).toEqual({});
  });

  it("extracts percentage numbers separately", () => {
    expect(extractPromptNumbers(prompt)).toEqual(
      expect.arrayContaining([
        { value: 15, kind: "percent" },
        { value: 20, kind: "percent" },
        { value: 5000, kind: "money" },
      ]),
    );
  });

  it("rejects an amount that is not present in the prompt", () => {
    const result = sanitizeScenarioParams(
      "SIP_INCREASE",
      { additionalMonthlyAmount: 10000 },
      "Increase my SIP by ₹5,000 per month.",
    );

    expect(result.params).toEqual({});
    expect(result.dropped).toContain("additionalMonthlyAmount");
  });
});
