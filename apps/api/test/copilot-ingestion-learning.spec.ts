import { ruleBasedCategorySuggestion } from "../src/ai/copilot-ingestion/merchant/rule-based-category-fallback";
import { CategoryRankingModel } from "../src/ai/copilot-ingestion/scoring/category-ranking.model";
import { MerchantMemoryService } from "../src/ai/copilot-ingestion/merchant/merchant-memory.service";
import { OcrQualityEstimationService } from "../src/ai/copilot-ingestion/parsing/ocr-quality-estimation.service";
import { ReconciliationService } from "../src/ai/copilot-ingestion/reconciliation/reconciliation.service";
import { SuggestionScoringService } from "../src/ai/copilot-ingestion/scoring/suggestion-scoring.service";
import { scrubPii } from "../src/ai/copilot-ingestion/privacy/pii-scrub.util";

const CATEGORIES = [
  { id: "c-food", name: "Food & Dining" },
  { id: "c-transport", name: "Transport" },
  { id: "c-groceries", name: "Groceries" },
];

describe("ruleBasedCategorySuggestion", () => {
  it("matches a known food-delivery merchant to a Food & Dining category", () => {
    const result = ruleBasedCategorySuggestion("Swiggy", CATEGORIES);
    expect(result?.categoryId).toBe("c-food");
    expect(result?.confidence).toBeLessThan(0.5); // deliberately low-trust fallback
  });

  it("matches a ride-hailing merchant to Transport", () => {
    const result = ruleBasedCategorySuggestion("Uber India", CATEGORIES);
    expect(result?.categoryId).toBe("c-transport");
  });

  it("returns null when no rule matches", () => {
    expect(ruleBasedCategorySuggestion("Some Unrecognizable Business Pvt Ltd", CATEGORIES)).toBeNull();
  });

  it("returns null when a rule matches but the user has no category with a matching name", () => {
    expect(ruleBasedCategorySuggestion("Netflix", CATEGORIES)).toBeNull(); // no "subscription"/"entertainment" category in this user's list
  });

  it("never returns a categoryId absent from the caller's own category list", () => {
    const result = ruleBasedCategorySuggestion("Bigbasket", CATEGORIES);
    expect(CATEGORIES.some((c) => c.id === result?.categoryId)).toBe(true);
  });
});

function fakePrismaFor(profileRow: unknown) {
  const upsert = jest.fn().mockResolvedValue(undefined);
  return {
    client: {
      suggestionRankingProfile: {
        findUnique: jest.fn().mockResolvedValue(profileRow),
        upsert,
      },
    },
  } as never;
}

describe("CategoryRankingModel", () => {
  it("picks the category with the highest weighted score across candidates", async () => {
    const prisma = fakePrismaFor(null); // no profile row yet -> default weights {memory:0.5, ai:0.4, global:0.1}
    const model = new CategoryRankingModel(prisma);

    const ranked = await model.rank("u1", {
      memory: { categoryId: "c-food", categoryName: "Food & Dining", confidence: 0.9 },
      ai: { categoryId: "c-transport", categoryName: "Transport", confidence: 0.6 },
      global: null,
    });

    // memory: 0.5*0.9 = 0.45, ai: 0.4*0.6 = 0.24 -> memory wins
    expect(ranked?.categoryId).toBe("c-food");
    expect(ranked?.source).toBe("memory");
  });

  it("labels the result 'blended' when more than one source agrees on the same category", async () => {
    const prisma = fakePrismaFor(null);
    const model = new CategoryRankingModel(prisma);

    const ranked = await model.rank("u1", {
      memory: { categoryId: "c-food", categoryName: "Food & Dining", confidence: 0.5 },
      ai: { categoryId: "c-food", categoryName: "Food & Dining", confidence: 0.5 },
      global: null,
    });

    expect(ranked?.source).toBe("blended");
  });

  it("returns null when there are no candidates at all", async () => {
    const prisma = fakePrismaFor(null);
    const model = new CategoryRankingModel(prisma);
    const ranked = await model.rank("u1", { memory: null, ai: null, global: null });
    expect(ranked).toBeNull();
  });

  it("never returns a confidence above 1 even if weights/confidences are pushed high", async () => {
    const prisma = fakePrismaFor({ weightMemory: 0.9, weightAi: 0.9, weightGlobal: 0.9 });
    const model = new CategoryRankingModel(prisma);
    const ranked = await model.rank("u1", {
      memory: { categoryId: "c-food", categoryName: "Food & Dining", confidence: 1 },
      ai: { categoryId: "c-food", categoryName: "Food & Dining", confidence: 1 },
      global: { categoryId: "c-food", categoryName: "Food & Dining", confidence: 1 },
    });
    expect(ranked!.confidence).toBeLessThanOrEqual(1);
  });

  it("increases the winning source's weight after a correct suggestion", async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      client: {
        suggestionRankingProfile: {
          findUnique: jest.fn().mockResolvedValue({ weightMemory: 0.5, weightAi: 0.4, weightGlobal: 0.1 }),
          upsert,
        },
      },
    } as never;
    const model = new CategoryRankingModel(prisma);

    await model.learnFromCorrection("u1", "ai", true);

    const updateArg = upsert.mock.calls[0][0].update;
    expect(updateArg.weightAi).toBeGreaterThan(0.4);
  });

  it("decreases the winning source's weight after an incorrect suggestion, clamped to the floor", async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      client: {
        suggestionRankingProfile: {
          findUnique: jest.fn().mockResolvedValue({ weightMemory: 0.06, weightAi: 0.4, weightGlobal: 0.1 }),
          upsert,
        },
      },
    } as never;
    const model = new CategoryRankingModel(prisma);

    await model.learnFromCorrection("u1", "memory", false);

    const updateArg = upsert.mock.calls[0][0].update;
    expect(updateArg.weightMemory).toBeGreaterThanOrEqual(0.05); // never below SUGGESTION_RANKING_MIN_WEIGHT
    expect(updateArg.weightMemory).toBeLessThan(0.06);
  });

  it("is a no-op for a rule_based_fallback or none source (nothing to attribute weight to)", async () => {
    const upsert = jest.fn();
    const prisma = { client: { suggestionRankingProfile: { findUnique: jest.fn(), upsert } } } as never;
    const model = new CategoryRankingModel(prisma);

    await model.learnFromCorrection("u1", "rule_based_fallback", true);
    await model.learnFromCorrection("u1", "none", false);

    expect(upsert).not.toHaveBeenCalled();
  });
});

function fakeEmbeddingService(vector: number[] = [1, 0, 0]) {
  return { embed: jest.fn().mockResolvedValue(vector) } as never;
}

describe("MerchantMemoryService", () => {
  it("returns a fresh memory row's confidence roughly unchanged (no meaningful decay yet)", async () => {
    const row = {
      categoryId: "c-food",
      categoryName: "Food & Dining",
      confidence: 0.7,
      acceptedCount: 2,
      overrideCount: 0,
      lastAcceptedAt: new Date(), // just now
    };
    const prisma = { client: { merchantCategoryMemory: { findUnique: jest.fn().mockResolvedValue(row) } } } as never;
    const service = new MerchantMemoryService(prisma, fakeEmbeddingService());

    const result = await service.lookup("u1", "Swiggy");
    expect(result?.confidence).toBeCloseTo(0.7, 1);
    expect(result?.matchType).toBe("exact");
  });

  it("decays confidence for an old memory row and drops it below the reliability floor eventually", async () => {
    const veryOld = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 3); // 3 years ago
    const row = {
      categoryId: "c-food",
      categoryName: "Food & Dining",
      confidence: 0.7,
      acceptedCount: 2,
      overrideCount: 0,
      lastAcceptedAt: veryOld,
    };
    const prisma = { client: { merchantCategoryMemory: { findUnique: jest.fn().mockResolvedValue(row) } } } as never;
    const service = new MerchantMemoryService(prisma, fakeEmbeddingService());

    const result = await service.lookup("u1", "Swiggy");
    expect(result).toBeNull(); // decayed below MERCHANT_MEMORY_MIN_CONFIDENCE_FLOOR
  });

  it("returns null when there is no memory row at all", async () => {
    const prisma = { client: { merchantCategoryMemory: { findUnique: jest.fn().mockResolvedValue(null) } } } as never;
    const service = new MerchantMemoryService(prisma, fakeEmbeddingService());
    expect(await service.lookup("u1", "Unknown Merchant")).toBeNull();
  });

  it("creates a new memory row on first feedback with the initial (not max) confidence", async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const upsert = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      client: {
        merchantCategoryMemory: { findUnique: jest.fn().mockResolvedValue(null), create },
        merchantCategoryGlobalStat: { upsert },
      },
    } as never;
    const service = new MerchantMemoryService(prisma, fakeEmbeddingService());

    await service.recordFeedback("u1", "Swiggy", "c-food", "Food & Dining");

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.categoryId).toBe("c-food");
    expect(data.confidence).toBeLessThan(1);
    expect(data.acceptedCount).toBe(1);
  });

  it("switches the mapped category once overrides catch up with acceptances", async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const existing = {
      id: "row1",
      categoryId: "c-food",
      categoryName: "Food & Dining",
      confidence: 0.6,
      acceptedCount: 1,
      overrideCount: 0, // one more override will now equal acceptedCount -> triggers switch
      lastAcceptedAt: new Date(),
    };
    const prisma = {
      client: {
        merchantCategoryMemory: { findUnique: jest.fn().mockResolvedValue(existing), update },
        merchantCategoryGlobalStat: { upsert: jest.fn().mockResolvedValue(undefined) },
      },
    } as never;
    const service = new MerchantMemoryService(prisma, fakeEmbeddingService());

    await service.recordFeedback("u1", "Swiggy", "c-groceries", "Groceries");

    const data = update.mock.calls[0][0].data;
    expect(data.categoryId).toBe("c-groceries");
    expect(data.acceptedCount).toBe(1);
    expect(data.overrideCount).toBe(0);
  });

  it("flags active-learning review for a merchant with too few observations even at high confidence", () => {
    const prisma = {} as never;
    const service = new MerchantMemoryService(prisma, fakeEmbeddingService());
    const entry = { categoryId: "c-food", categoryName: "Food", confidence: 0.95, sampleSize: 1, matchType: "exact" as const };
    expect(service.needsActiveLearningReview(entry, 0.95)).toBe(true);
  });

  it("does not flag active-learning review for an established, confident merchant", () => {
    const prisma = {} as never;
    const service = new MerchantMemoryService(prisma, fakeEmbeddingService());
    const entry = { categoryId: "c-food", categoryName: "Food", confidence: 0.9, sampleSize: 10, matchType: "exact" as const };
    expect(service.needsActiveLearningReview(entry, 0.9)).toBe(false);
  });
});

describe("OcrQualityEstimationService", () => {
  const service = new OcrQualityEstimationService();

  it("scores highly when both the OCR engine and the deterministic parser agree the text is clean", () => {
    const result = service.estimate({ engineConfidence: 0.95, totalLines: 20, deterministicallyParsedLines: 19 });
    expect(result.extractionConfidence).toBeGreaterThan(0.8);
  });

  it("scores low when the engine is confident but almost nothing parsed as a real transaction", () => {
    const result = service.estimate({ engineConfidence: 0.9, totalLines: 20, deterministicallyParsedLines: 1 });
    expect(result.extractionConfidence).toBeLessThan(0.5);
  });

  it("returns zero confidence for an image with no recognized text at all", () => {
    const result = service.estimate({ engineConfidence: 0, totalLines: 0, deterministicallyParsedLines: 0 });
    expect(result.extractionConfidence).toBe(0);
  });
});

describe("ReconciliationService", () => {
  function serviceWith(loans: unknown[], investments: unknown[]) {
    const loansService = { list: jest.fn().mockResolvedValue(loans) } as never;
    const investmentsService = { list: jest.fn().mockResolvedValue(investments) } as never;
    return new ReconciliationService(loansService, investmentsService);
  }

  it("classifies a plain merchant line as a regular EXPENSE", async () => {
    const service = serviceWith([], []);
    const result = await service.classifyLine("u1", { merchantNormalized: "Swiggy", amount: 450, date: new Date() });
    expect(result.transactionKind).toBe("EXPENSE");
  });

  it("matches an EMI line to an existing loan by lender name and flags no mismatch when amounts agree", async () => {
    const loans = [{ id: "loan1", lender: "HDFC Bank", emiAmount: 15000 }];
    const service = serviceWith(loans, []);
    const result = await service.classifyLine("u1", { merchantNormalized: "HDFC EMI Payment", amount: 15000, date: new Date() });
    expect(result.transactionKind).toBe("LOAN_EMI");
    expect(result.matchedRecordId).toBe("loan1");
    expect(result.reconciliationNote).toContain("Matches");
  });

  it("flags an amount mismatch when the statement EMI differs materially from the recorded EMI", async () => {
    const loans = [{ id: "loan1", lender: "HDFC Bank", emiAmount: 15000 }];
    const service = serviceWith(loans, []);
    const result = await service.classifyLine("u1", { merchantNormalized: "HDFC EMI Payment", amount: 18000, date: new Date() });
    expect(result.matchedRecordId).toBe("loan1");
    expect(result.reconciliationNote).toContain("recorded EMI");
  });

  it("flags an EMI-looking line with no matching loan record as unmatched", async () => {
    const service = serviceWith([], []);
    const result = await service.classifyLine("u1", { merchantNormalized: "Personal Loan EMI", amount: 5000, date: new Date() });
    expect(result.transactionKind).toBe("LOAN_EMI");
    expect(result.matchedRecordId).toBeNull();
    expect(result.reconciliationNote).toContain("no matching Loan record");
  });

  it("reconcileBatch reports MISSING_EXPECTED_EMI for a loan whose EMI never appears across a full-month batch", async () => {
    const loans = [{ id: "loan1", lender: "ICICI Bank", emiAmount: 12000 }];
    const service = serviceWith(loans, []);
    const items = [
      { rawLine: "Swiggy 400", merchantNormalized: "Swiggy", parsedAmount: 400, parsedDate: new Date("2026-01-01"), status: "PENDING" },
      { rawLine: "Amazon 900", merchantNormalized: "Amazon", parsedAmount: 900, parsedDate: new Date("2026-01-28"), status: "PENDING" },
    ];
    const report = await service.reconcileBatch("u1", items);
    expect(report.findings.some((f) => f.type === "MISSING_EXPECTED_EMI" && f.loanId === "loan1")).toBe(true);
  });

  it("does not report MISSING_EXPECTED_EMI for a short-span batch that isn't a full statement cycle", async () => {
    const loans = [{ id: "loan1", lender: "ICICI Bank", emiAmount: 12000 }];
    const service = serviceWith(loans, []);
    const items = [
      { rawLine: "Swiggy 400", merchantNormalized: "Swiggy", parsedAmount: 400, parsedDate: new Date("2026-01-01"), status: "PENDING" },
      { rawLine: "Amazon 900", merchantNormalized: "Amazon", parsedAmount: 900, parsedDate: new Date("2026-01-05"), status: "PENDING" },
    ];
    const report = await service.reconcileBatch("u1", items);
    expect(report.findings.some((f) => f.type === "MISSING_EXPECTED_EMI")).toBe(false);
  });
});

describe("SuggestionScoringService — active learning + new signals", () => {
  const service = new SuggestionScoringService();

  it("flags needsActiveLearningReview for a first-time merchant even with a high confidence number", () => {
    const result = service.score({
      categorySuggestionConfidence: 0.95,
      isDuplicateCandidate: false,
      duplicateConfidence: 0,
      isRecurringCandidate: false,
      isAnomalyCandidate: false,
      missingFields: [],
      merchantMemorySampleSize: 0,
    });
    expect(result.needsActiveLearningReview).toBe(true);
  });

  it("does not flag an established, confident merchant", () => {
    const result = service.score({
      categorySuggestionConfidence: 0.9,
      isDuplicateCandidate: false,
      duplicateConfidence: 0,
      isRecurringCandidate: false,
      isAnomalyCandidate: false,
      missingFields: [],
      merchantMemorySampleSize: 10,
    });
    expect(result.needsActiveLearningReview).toBe(false);
  });

  it("caps confidence to the OCR extraction confidence when it's the limiting factor", () => {
    const result = service.score({
      categorySuggestionConfidence: 0.95,
      isDuplicateCandidate: false,
      duplicateConfidence: 0,
      isRecurringCandidate: false,
      isAnomalyCandidate: false,
      missingFields: [],
      merchantMemorySampleSize: 10,
      ocrExtractionConfidence: 0.3,
    });
    expect(result.overallConfidence).toBeLessThanOrEqual(0.3);
    expect(result.rationale).toContain("OCR extraction confidence");
  });

  it("caps confidence when a reconciliation mismatch is flagged", () => {
    const result = service.score({
      categorySuggestionConfidence: 0.95,
      isDuplicateCandidate: false,
      duplicateConfidence: 0,
      isRecurringCandidate: false,
      isAnomalyCandidate: false,
      missingFields: [],
      merchantMemorySampleSize: 10,
      hasReconciliationMismatch: true,
    });
    expect(result.overallConfidence).toBeLessThanOrEqual(0.5);
  });
});

describe("scrubPii", () => {
  it("redacts a card-shaped number embedded in raw statement text", () => {
    expect(scrubPii("POS PURCHASE 4111 1111 1111 1111 AMAZON")).toContain("[REDACTED_CARD]");
  });

  it("redacts an Indian 10-digit mobile number", () => {
    expect(scrubPii("Contact 9876543210 for support")).toContain("[REDACTED_PHONE]");
  });

  it("redacts an email address", () => {
    expect(scrubPii("Receipt sent to jane.doe@example.com")).toContain("[REDACTED_EMAIL]");
  });

  it("redacts a PAN-shaped string", () => {
    expect(scrubPii("PAN on file: ABCDE1234F")).toContain("[REDACTED_PAN]");
  });

  it("leaves ordinary merchant text untouched", () => {
    expect(scrubPii("SWIGGY BANGALORE")).toBe("SWIGGY BANGALORE");
  });
});
