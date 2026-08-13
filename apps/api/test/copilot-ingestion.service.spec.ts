import { Test } from "@nestjs/testing";
import { CopilotIngestionService } from "../src/ai/copilot-ingestion/copilot-ingestion.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { FeatureExtractionService } from "../src/ai/ml-insights/features/feature-extraction.service";
import { StatementUnderstandingService } from "../src/ai/copilot-ingestion/parsing/statement-understanding.service";
import { StatementOcrAdapter } from "../src/ai/copilot-ingestion/parsing/statement-ocr.adapter";
import { OcrQualityEstimationService } from "../src/ai/copilot-ingestion/parsing/ocr-quality-estimation.service";
import { CategorySuggestionService } from "../src/ai/copilot-ingestion/merchant/category-suggestion.service";
import { DuplicateDetectionService } from "../src/ai/copilot-ingestion/detection/duplicate-detection.service";
import { RecurringDetectionService } from "../src/ai/copilot-ingestion/detection/recurring-detection.service";
import { AnomalyFlaggingService } from "../src/ai/copilot-ingestion/detection/anomaly-flagging.service";
import { ReconciliationService } from "../src/ai/copilot-ingestion/reconciliation/reconciliation.service";
import { SuggestionScoringService } from "../src/ai/copilot-ingestion/scoring/suggestion-scoring.service";

// Text with zero parseable statement lines throughout these tests — so the per-line
// detection/suggestion pipeline (already covered by copilot-ingestion-detection.spec.ts
// / copilot-ingestion-learning.spec.ts) never needs to run, keeping this test suite
// focused on the new bridge method's own logic.
describe("CopilotIngestionService.ingestFromDocumentText (new, audit item #6)", () => {
  let service: CopilotIngestionService;

  const mockPrisma = { client: { ingestionBatch: { create: jest.fn() } } };
  const mockExpenses = { listCategories: jest.fn(), list: jest.fn(), detectSubscriptions: jest.fn() };
  const mockFeatures = { transactionPoints: jest.fn() };
  const mockUnderstanding = { parseLeftoverLines: jest.fn() };
  const mockOcrAdapter = { process: jest.fn() };
  const mockOcrQuality = { estimate: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockExpenses.listCategories.mockResolvedValue([]);
    mockExpenses.list.mockResolvedValue([]);
    mockExpenses.detectSubscriptions.mockResolvedValue([]);
    mockFeatures.transactionPoints.mockResolvedValue([]);
    mockUnderstanding.parseLeftoverLines.mockResolvedValue([]);
    mockOcrQuality.estimate.mockReturnValue({ extractionConfidence: 0.8 });
    mockPrisma.client.ingestionBatch.create.mockResolvedValue({ id: "batch-1", items: [] });

    const moduleRef = await Test.createTestingModule({
      providers: [
        CopilotIngestionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ExpensesService, useValue: mockExpenses },
        { provide: FeatureExtractionService, useValue: mockFeatures },
        { provide: StatementUnderstandingService, useValue: mockUnderstanding },
        { provide: StatementOcrAdapter, useValue: mockOcrAdapter },
        { provide: OcrQualityEstimationService, useValue: mockOcrQuality },
        // Never invoked in these tests (zero parseable lines means the per-line
        // item-building pipeline never runs) — trivial stubs are sufficient.
        { provide: CategorySuggestionService, useValue: {} },
        { provide: DuplicateDetectionService, useValue: {} },
        { provide: RecurringDetectionService, useValue: {} },
        { provide: AnomalyFlaggingService, useValue: {} },
        { provide: ReconciliationService, useValue: {} },
        { provide: SuggestionScoringService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(CopilotIngestionService);
  });

  it("creates a batch with ingestionSource DOCUMENT_OCR and the given sourceDocumentId", async () => {
    await service.ingestFromDocumentText(
      "user-1",
      "Bank statement — file.pdf",
      "no parseable lines here",
      0.9,
      "BANK_TRANSFER",
      "doc-1",
    );

    expect(mockPrisma.client.ingestionBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          ingestionSource: "DOCUMENT_OCR",
          sourceDocumentId: "doc-1",
        }),
      }),
    );
  });

  it("does NOT re-run OCR — this method starts from already-extracted text", async () => {
    await service.ingestFromDocumentText("user-1", "label", "some text", 0.9, "BANK_TRANSFER", "doc-1");

    expect(mockOcrAdapter.process).not.toHaveBeenCalled();
  });

  it("passes the given engineConfidence through to OcrQualityEstimationService", async () => {
    await service.ingestFromDocumentText("user-1", "label", "some text", 0.73, "BANK_TRANSFER", "doc-1");

    expect(mockOcrQuality.estimate).toHaveBeenCalledWith(expect.objectContaining({ engineConfidence: 0.73 }));
  });

  it("defaults engineConfidence to a neutral 0.5 when undefined (e.g. from MockOcrAdapter)", async () => {
    await service.ingestFromDocumentText("user-1", "label", "some text", undefined, "BANK_TRANSFER", "doc-1");

    expect(mockOcrQuality.estimate).toHaveBeenCalledWith(expect.objectContaining({ engineConfidence: 0.5 }));
  });

  it("uses the estimated extractionConfidence as the batch's ocrExtractionConfidence", async () => {
    mockOcrQuality.estimate.mockReturnValue({ extractionConfidence: 0.42 });

    await service.ingestFromDocumentText("user-1", "label", "some text", 0.9, "BANK_TRANSFER", "doc-1");

    expect(mockPrisma.client.ingestionBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ocrExtractionConfidence: 0.42 }) }),
    );
  });

  it("still produces a normal staged batch — never auto-creates an Expense directly", async () => {
    const result = await service.ingestFromDocumentText("user-1", "label", "some text", 0.9, "BANK_TRANSFER", "doc-1");

    expect(result).toEqual({ id: "batch-1", items: [] });
    // ingestFromDocumentText itself never calls expenses.create — only approval,
    // via the existing, separate IngestionReviewService, ever does that.
  });
});

describe("CopilotIngestionService.ingest (regression guard — sourceDocumentId stays null for plain text imports)", () => {
  let service: CopilotIngestionService;
  const mockPrisma = { client: { ingestionBatch: { create: jest.fn() } } };
  const mockExpenses = { listCategories: jest.fn(), list: jest.fn(), detectSubscriptions: jest.fn() };
  const mockFeatures = { transactionPoints: jest.fn() };
  const mockUnderstanding = { parseLeftoverLines: jest.fn() };
  const mockOcrAdapter = { process: jest.fn() };
  const mockOcrQuality = { estimate: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockExpenses.listCategories.mockResolvedValue([]);
    mockExpenses.list.mockResolvedValue([]);
    mockExpenses.detectSubscriptions.mockResolvedValue([]);
    mockFeatures.transactionPoints.mockResolvedValue([]);
    mockUnderstanding.parseLeftoverLines.mockResolvedValue([]);
    mockPrisma.client.ingestionBatch.create.mockResolvedValue({ id: "batch-1", items: [] });

    const moduleRef = await Test.createTestingModule({
      providers: [
        CopilotIngestionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ExpensesService, useValue: mockExpenses },
        { provide: FeatureExtractionService, useValue: mockFeatures },
        { provide: StatementUnderstandingService, useValue: mockUnderstanding },
        { provide: StatementOcrAdapter, useValue: mockOcrAdapter },
        { provide: OcrQualityEstimationService, useValue: mockOcrQuality },
        { provide: CategorySuggestionService, useValue: {} },
        { provide: DuplicateDetectionService, useValue: {} },
        { provide: RecurringDetectionService, useValue: {} },
        { provide: AnomalyFlaggingService, useValue: {} },
        { provide: ReconciliationService, useValue: {} },
        { provide: SuggestionScoringService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(CopilotIngestionService);
  });

  it("a plain pasted-text import still gets ingestionSource TEXT and sourceDocumentId null", async () => {
    await service.ingest("user-1", "Pasted statement", "some text", "UPI");

    expect(mockPrisma.client.ingestionBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ingestionSource: "TEXT", sourceDocumentId: null }) }),
    );
  });
});
