import { Test } from "@nestjs/testing";
import { IngestionReviewService } from "../src/ai/copilot-ingestion/review/ingestion-review.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { MerchantMemoryService } from "../src/ai/copilot-ingestion/merchant/merchant-memory.service";
import { CategoryRankingModel } from "../src/ai/copilot-ingestion/scoring/category-ranking.model";
import { RagAutoReindexService } from "../src/ai/ops/rag-auto-reindex.service";

describe("IngestionReviewService.approve RAG auto-reindex trigger (new, audit item #7)", () => {
  let service: IngestionReviewService;

  const mockPrisma = {
    client: {
      ingestionReviewItem: { findUnique: jest.fn(), update: jest.fn() },
      category: { findUnique: jest.fn() },
    },
  };
  const mockExpenses = { create: jest.fn(), update: jest.fn() };
  const mockMerchantMemory = { recordFeedback: jest.fn().mockResolvedValue(undefined) };
  const mockRanking = { learnFromCorrection: jest.fn().mockResolvedValue(undefined) };
  const mockRagAutoReindex = { triggerFor: jest.fn().mockResolvedValue(undefined) };

  const pendingItem = {
    id: "item-1",
    userId: "user-1",
    status: "PENDING",
    isDuplicateCandidate: false,
    suggestedCategoryId: "cat-1",
    suggestionSource: "AI",
    merchantNormalized: "Netflix",
    parsedAmount: 500,
    parsedDate: new Date("2026-07-01"),
    isRecurringCandidate: true,
    duplicateOfExpenseId: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.category.findUnique.mockResolvedValue({ id: "cat-1", name: "Subscriptions" });
    const moduleRef = await Test.createTestingModule({
      providers: [
        IngestionReviewService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ExpensesService, useValue: mockExpenses },
        { provide: MerchantMemoryService, useValue: mockMerchantMemory },
        { provide: CategoryRankingModel, useValue: mockRanking },
        { provide: RagAutoReindexService, useValue: mockRagAutoReindex },
      ],
    }).compile();
    service = moduleRef.get(IngestionReviewService);
  });

  it("triggers a reindex when a new Expense is created from approval", async () => {
    mockPrisma.client.ingestionReviewItem.findUnique.mockResolvedValue(pendingItem);
    mockExpenses.create.mockResolvedValue({ id: "expense-1" });
    mockPrisma.client.ingestionReviewItem.update.mockResolvedValue({ id: "item-1", status: "APPROVED" });

    await service.approve("user-1", "item-1");

    expect(mockRagAutoReindex.triggerFor).toHaveBeenCalledWith("user-1");
  });

  it("triggers a reindex when approval merges into an existing expense", async () => {
    mockPrisma.client.ingestionReviewItem.findUnique.mockResolvedValue({
      ...pendingItem,
      isDuplicateCandidate: true,
      duplicateOfExpenseId: "expense-existing",
      rationale: "Similar merchant/amount/date",
    });
    mockExpenses.update.mockResolvedValue({ id: "expense-existing" });
    mockPrisma.client.ingestionReviewItem.update.mockResolvedValue({ id: "item-1", status: "APPROVED" });

    await service.approve("user-1", "item-1", {}, "merged");

    expect(mockRagAutoReindex.triggerFor).toHaveBeenCalledWith("user-1");
  });

  it("does NOT trigger a reindex when the item is skipped as a duplicate — nothing new was written", async () => {
    mockPrisma.client.ingestionReviewItem.findUnique.mockResolvedValue({
      ...pendingItem,
      isDuplicateCandidate: true,
      rationale: "Similar merchant/amount/date",
    });
    mockPrisma.client.ingestionReviewItem.update.mockResolvedValue({ id: "item-1", status: "REJECTED" });

    await service.approve("user-1", "item-1", {}, "skipped_duplicate");

    expect(mockRagAutoReindex.triggerFor).not.toHaveBeenCalled();
    expect(mockExpenses.create).not.toHaveBeenCalled();
  });
});
