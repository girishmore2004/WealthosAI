import { GroundingService } from "../src/ai/gateway/grounding.service";

describe("GroundingService", () => {
  const grounding = new GroundingService();

  it("scores a fully grounded response as low risk", () => {
    const context = "Portfolio value increased from ₹100,000 to ₹105,000 this month, a gain of 5%.";
    const response = "Your portfolio grew by 5% this month, from ₹100,000 to ₹105,000.";

    const result = grounding.score(response, context);

    expect(result.risk).toBe("low");
    expect(result.unmatchedNumbers).toHaveLength(0);
  });

  it("flags a fabricated number not present anywhere in the context as high risk", () => {
    const context = "Portfolio value increased from ₹100,000 to ₹105,000 this month.";
    const response = "Your portfolio grew by 45% this month.";

    const result = grounding.score(response, context);

    expect(result.risk).toBe("high");
    expect(result.unmatchedNumbers).toContain("45%");
  });

  it("tolerates minor rounding/formatting differences in amounts", () => {
    const context = "Total assets: ₹1,234,567";
    const response = "Your total assets are approximately ₹1,234,570"; // within 1% tolerance

    const result = grounding.score(response, context);

    expect(result.unmatchedNumbers).toHaveLength(0);
  });

  it("scores a response with no numbers as fully grounded on the numeric axis", () => {
    const context = "Portfolio value increased from ₹100,000 to ₹105,000 this month.";
    const response = "Your portfolio is trending in a positive direction.";

    const result = grounding.score(response, context);

    expect(result.unmatchedNumbers).toHaveLength(0);
    expect(result.risk).not.toBe("high");
  });

  it("does not treat a percent value and a non-percent value with the same digits as a match", () => {
    const context = "Your expense ratio is 5.";
    const response = "Your expense ratio is 5%.";

    const result = grounding.score(response, context);

    expect(result.unmatchedNumbers).toContain("5%");
  });
});
