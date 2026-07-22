import { DuplicateDetectionService } from "../src/ai/copilot-ingestion/detection/duplicate-detection.service";
import { RecurringDetectionService } from "../src/ai/copilot-ingestion/detection/recurring-detection.service";
import { SuggestionScoringService } from "../src/ai/copilot-ingestion/scoring/suggestion-scoring.service";

describe("DuplicateDetectionService", () => {
  const service = new DuplicateDetectionService();

  it("flags an exact match (same merchant, same day, same amount) with high confidence", () => {
    const existing = [{ id: "e1", merchant: "Amazon.in", amount: 1249, spentAt: new Date("2026-01-15") }];
    const result = service.check({ merchantRaw: "POS AMAZON.IN 4829102", amount: 1249, date: new Date("2026-01-15") }, existing);
    expect(result.isDuplicateCandidate).toBe(true);
    expect(result.duplicateOfExpenseId).toBe("e1");
    expect(result.duplicateConfidence).toBeGreaterThan(0.9);
  });

  it("flags a near match (close date, tiny amount difference) with lower confidence", () => {
    const existing = [{ id: "e1", merchant: "Amazon.in", amount: 1249, spentAt: new Date("2026-01-15") }];
    const result = service.check({ merchantRaw: "AMAZON.IN", amount: 1249.5, date: new Date("2026-01-16") }, existing);
    expect(result.isDuplicateCandidate).toBe(true);
    expect(result.duplicateConfidence).toBeLessThan(0.9);
    expect(result.duplicateConfidence).toBeGreaterThan(0);
  });

  it("does not flag a transaction with a completely different merchant", () => {
    const existing = [{ id: "e1", merchant: "Amazon.in", amount: 1249, spentAt: new Date("2026-01-15") }];
    const result = service.check({ merchantRaw: "SWIGGY", amount: 1249, date: new Date("2026-01-15") }, existing);
    expect(result.isDuplicateCandidate).toBe(false);
  });

  it("does not flag a same-merchant transaction with a very different amount and date (likely a separate purchase)", () => {
    const existing = [{ id: "e1", merchant: "Amazon.in", amount: 1249, spentAt: new Date("2026-01-15") }];
    const result = service.check({ merchantRaw: "AMAZON.IN", amount: 5000, date: new Date("2026-02-20") }, existing);
    expect(result.isDuplicateCandidate).toBe(false);
  });

  it("ignores existing expenses with no merchant recorded", () => {
    const existing = [{ id: "e1", merchant: null, amount: 1249, spentAt: new Date("2026-01-15") }];
    const result = service.check({ merchantRaw: "AMAZON.IN", amount: 1249, date: new Date("2026-01-15") }, existing);
    expect(result.isDuplicateCandidate).toBe(false);
  });
});

describe("RecurringDetectionService", () => {
  const service = new RecurringDetectionService();

  it("matches a candidate against a known subscription by normalized merchant", () => {
    const subs = [{ merchant: "netflix.com", averageAmount: 649, confidence: "HIGH" as const }];
    const result = service.check({ merchantRaw: "NETFLIX.COM **1234" }, subs);
    expect(result.isRecurringCandidate).toBe(true);
    expect(result.recurringMatchMerchant).toBe("netflix.com");
  });

  it("does not match when there is no known subscription for this merchant", () => {
    const subs = [{ merchant: "netflix.com", averageAmount: 649, confidence: "HIGH" as const }];
    const result = service.check({ merchantRaw: "AMAZON.IN" }, subs);
    expect(result.isRecurringCandidate).toBe(false);
  });
});

describe("SuggestionScoringService", () => {
  const service = new SuggestionScoringService();

  it("gives high overall confidence for a clean, unflagged suggestion", () => {
    const result = service.score({
      categorySuggestionConfidence: 0.9,
      isDuplicateCandidate: false,
      duplicateConfidence: 0,
      isRecurringCandidate: false,
      isAnomalyCandidate: false,
      missingFields: [],
    });
    expect(result.overallConfidence).toBeCloseTo(0.9);
  });

  it("caps overall confidence low when flagged as a likely duplicate, even with a confident category guess", () => {
    const result = service.score({
      categorySuggestionConfidence: 0.95,
      isDuplicateCandidate: true,
      duplicateConfidence: 0.9,
      isRecurringCandidate: false,
      isAnomalyCandidate: false,
      missingFields: [],
    });
    expect(result.overallConfidence).toBeLessThan(0.2);
    expect(result.rationale).toContain("duplicate");
  });

  it("caps overall confidence at 0.4 when flagged as an anomaly", () => {
    const result = service.score({
      categorySuggestionConfidence: 0.99,
      isDuplicateCandidate: false,
      duplicateConfidence: 0,
      isRecurringCandidate: false,
      isAnomalyCandidate: true,
      missingFields: [],
    });
    expect(result.overallConfidence).toBeLessThanOrEqual(0.4);
  });

  it("reduces confidence and lists missing fields in the rationale", () => {
    const result = service.score({
      categorySuggestionConfidence: 0.9,
      isDuplicateCandidate: false,
      duplicateConfidence: 0,
      isRecurringCandidate: false,
      isAnomalyCandidate: false,
      missingFields: ["category (no confident suggestion)"],
    });
    expect(result.overallConfidence).toBeLessThanOrEqual(0.7);
    expect(result.rationale).toContain("missing");
  });

  it("never returns a confidence outside [0, 1]", () => {
    const result = service.score({
      categorySuggestionConfidence: 0,
      isDuplicateCandidate: true,
      duplicateConfidence: 1,
      isRecurringCandidate: false,
      isAnomalyCandidate: true,
      missingFields: ["a", "b"],
    });
    expect(result.overallConfidence).toBeGreaterThanOrEqual(0);
    expect(result.overallConfidence).toBeLessThanOrEqual(1);
  });
});
