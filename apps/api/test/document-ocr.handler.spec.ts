import { Test } from "@nestjs/testing";
import { DocumentOcrHandler } from "../src/documents/document-ocr.handler";
import { AiQueueService } from "../src/ai/ops/ai-queue.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { LocalDiskStorageAdapter } from "../src/documents/adapters/local-disk-storage.adapter";
import { OCR_ADAPTER } from "../src/documents/adapters/ocr-adapter.factory";
import { OcrNotApplicableError } from "../src/documents/adapters/ocr.adapter";
import { RagAutoReindexService } from "../src/ai/ops/rag-auto-reindex.service";
import { CopilotIngestionService } from "../src/ai/copilot-ingestion/copilot-ingestion.service";
import { DocumentReconciliationService } from "../src/documents/document-reconciliation.service";

describe("DocumentOcrHandler RAG auto-reindex trigger (new, audit item #7)", () => {
  let handler: DocumentOcrHandler;
  let registeredJobHandler: (input: unknown) => Promise<unknown>;

  const mockQueue = {
    registerHandler: jest.fn(
      (_type: string, fn: (input: unknown) => Promise<unknown>) => {
        registeredJobHandler = fn;
      },
    ),
  };

  const mockPrisma = {
    client: {
      document: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    },
  };

  const mockStorage = {
    read: jest.fn(),
  };

  const mockOcr = {
    process: jest.fn(),
  };

  const mockRagAutoReindex = {
    triggerFor: jest.fn().mockResolvedValue(undefined),
  };

  // Existing Copilot Ingestion dependency used by DocumentOcrHandler.
  const mockCopilotIngestion = {
    ingestFromDocumentText: jest
      .fn()
      .mockResolvedValue({ id: "batch-1" }),
  };

  // Required dependency added to DocumentOcrHandler.
  // This is a test double only; production reconciliation logic is unchanged.
  const mockReconciliation = {
    reconcile: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockCopilotIngestion.ingestFromDocumentText.mockResolvedValue({
      id: "batch-1",
    });

    mockReconciliation.reconcile.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentOcrHandler,

        { provide: AiQueueService, useValue: mockQueue },

        { provide: PrismaService, useValue: mockPrisma },

        { provide: LocalDiskStorageAdapter, useValue: mockStorage },

        { provide: OCR_ADAPTER, useValue: mockOcr },

        {
          provide: RagAutoReindexService,
          useValue: mockRagAutoReindex,
        },

        {
          provide: CopilotIngestionService,
          useValue: mockCopilotIngestion,
        },

        // FIX:
        // DocumentOcrHandler now injects DocumentReconciliationService
        // as constructor dependency #7 (index [6]).
        {
          provide: DocumentReconciliationService,
          useValue: mockReconciliation,
        },
      ],
    }).compile();

    handler = moduleRef.get(DocumentOcrHandler);

    // Registers the document.ocr job handler using the mocked queue.
    handler.onModuleInit();
  });

  it("triggers a reindex after a successful DONE OCR result", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc-1",
      userId: "user-1",
      storageKey: "k1",
      mimeType: "image/png",
      fileName: "statement.png",
    });

    mockStorage.read.mockResolvedValue(Buffer.from("fake"));

    mockOcr.process.mockResolvedValue({
      text: "extracted text",
      summary: "a summary",
    });

    mockPrisma.client.document.update.mockResolvedValue({});

    await registeredJobHandler({
      documentId: "doc-1",
      userId: "user-1",
      category: "BANK_STATEMENT",
    });

    expect(mockRagAutoReindex.triggerFor).toHaveBeenCalledWith("user-1");

    // Also exercises the Document -> Copilot Ingestion bridge.
    expect(
      mockCopilotIngestion.ingestFromDocumentText,
    ).toHaveBeenCalled();
  });

  it("triggers a reindex after a NOT_APPLICABLE result (metadata is still new, indexable content)", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc-1",
      userId: "user-1",
      storageKey: "k1",
      mimeType: "application/msword",
    });

    mockStorage.read.mockResolvedValue(Buffer.from("fake"));

    mockOcr.process.mockRejectedValue(
      new OcrNotApplicableError("Word documents are not supported"),
    );

    mockPrisma.client.document.update.mockResolvedValue({});

    await registeredJobHandler({
      documentId: "doc-1",
      userId: "user-1",
      category: "OTHER",
    });

    expect(mockRagAutoReindex.triggerFor).toHaveBeenCalledWith("user-1");
  });

  it("does NOT trigger a reindex when OCR genuinely fails (no new indexable content)", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc-1",
      userId: "user-1",
      storageKey: "k1",
      mimeType: "image/png",
    });

    mockStorage.read.mockResolvedValue(Buffer.from("fake"));

    mockOcr.process.mockRejectedValue(
      new Error("OCR engine crashed"),
    );

    mockPrisma.client.document.update.mockResolvedValue({});

    await expect(
      registeredJobHandler({
        documentId: "doc-1",
        userId: "user-1",
        category: "OTHER",
      }),
    ).rejects.toThrow("OCR engine crashed");

    expect(
      mockRagAutoReindex.triggerFor,
    ).not.toHaveBeenCalled();
  });

  it("does not trigger a reindex when the document was deleted before the job ran", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue(null);

    await registeredJobHandler({
      documentId: "doc-1",
      userId: "user-1",
      category: "OTHER",
    });

    expect(
      mockRagAutoReindex.triggerFor,
    ).not.toHaveBeenCalled();

    expect(mockOcr.process).not.toHaveBeenCalled();
  });
});

describe("DocumentOcrHandler Document-Ingestion bridge (new, audit item #6)", () => {
  let handler: DocumentOcrHandler;
  let registeredJobHandler: (input: unknown) => Promise<unknown>;

  const mockQueue = {
    registerHandler: jest.fn(
      (_type: string, fn: (input: unknown) => Promise<unknown>) => {
        registeredJobHandler = fn;
      },
    ),
  };

  const mockPrisma = {
    client: {
      document: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    },
  };

  const mockStorage = {
    read: jest.fn(),
  };

  const mockOcr = {
    process: jest.fn(),
  };

  const mockRagAutoReindex = {
    triggerFor: jest.fn().mockResolvedValue(undefined),
  };

  const mockCopilotIngestion = {
    ingestFromDocumentText: jest.fn(),
  };

  const mockReconciliation = {
    reconcile: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockCopilotIngestion.ingestFromDocumentText.mockResolvedValue({
      id: "batch-1",
    });

    mockReconciliation.reconcile.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentOcrHandler,

        { provide: AiQueueService, useValue: mockQueue },

        { provide: PrismaService, useValue: mockPrisma },

        { provide: LocalDiskStorageAdapter, useValue: mockStorage },

        { provide: OCR_ADAPTER, useValue: mockOcr },

        {
          provide: RagAutoReindexService,
          useValue: mockRagAutoReindex,
        },

        {
          provide: CopilotIngestionService,
          useValue: mockCopilotIngestion,
        },

        // FIX:
        // Provide the newly injected reconciliation service
        // so Nest can construct DocumentOcrHandler in the test module.
        {
          provide: DocumentReconciliationService,
          useValue: mockReconciliation,
        },
      ],
    }).compile();

    handler = moduleRef.get(DocumentOcrHandler);

    handler.onModuleInit();
  });

  it("bridges a BANK_STATEMENT document's OCR text into Copilot Ingestion with the correct arguments", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc-1",
      userId: "user-1",
      storageKey: "k1",
      mimeType: "image/png",
      fileName: "hdfc-statement.png",
    });

    mockStorage.read.mockResolvedValue(Buffer.from("fake"));

    mockOcr.process.mockResolvedValue({
      text: "01/07/2026 Zomato 450.00",
      summary: "a summary",
      engineConfidence: 0.87,
    });

    mockPrisma.client.document.update.mockResolvedValue({});

    await registeredJobHandler({
      documentId: "doc-1",
      userId: "user-1",
      category: "BANK_STATEMENT",
    });

    expect(
      mockCopilotIngestion.ingestFromDocumentText,
    ).toHaveBeenCalledWith(
      "user-1",
      expect.stringContaining("hdfc-statement.png"),
      "01/07/2026 Zomato 450.00",
      0.87,
      "BANK_TRANSFER",
      "doc-1",
    );
  });

  it("does NOT bridge a document in any other category (e.g. SALARY_SLIP, INSURANCE_POLICY)", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc-1",
      userId: "user-1",
      storageKey: "k1",
      mimeType: "image/png",
      fileName: "payslip.png",
    });

    mockStorage.read.mockResolvedValue(Buffer.from("fake"));

    mockOcr.process.mockResolvedValue({
      text: "some text",
      summary: "a summary",
      engineConfidence: 0.9,
    });

    mockPrisma.client.document.update.mockResolvedValue({});

    await registeredJobHandler({
      documentId: "doc-1",
      userId: "user-1",
      category: "SALARY_SLIP",
    });

    expect(
      mockCopilotIngestion.ingestFromDocumentText,
    ).not.toHaveBeenCalled();
  });

  it("does not bridge a BANK_STATEMENT document when OCR result is NOT_APPLICABLE (no usable text)", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc-1",
      userId: "user-1",
      storageKey: "k1",
      mimeType: "application/msword",
      fileName: "statement.doc",
    });

    mockStorage.read.mockResolvedValue(Buffer.from("fake"));

    mockOcr.process.mockRejectedValue(
      new OcrNotApplicableError(
        "Word documents are not supported",
      ),
    );

    mockPrisma.client.document.update.mockResolvedValue({});

    await registeredJobHandler({
      documentId: "doc-1",
      userId: "user-1",
      category: "BANK_STATEMENT",
    });

    expect(
      mockCopilotIngestion.ingestFromDocumentText,
    ).not.toHaveBeenCalled();
  });

  it("does not fail document OCR processing when the bridge itself throws — best-effort by design", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc-1",
      userId: "user-1",
      storageKey: "k1",
      mimeType: "image/png",
      fileName: "statement.png",
    });

    mockStorage.read.mockResolvedValue(Buffer.from("fake"));

    mockOcr.process.mockResolvedValue({
      text: "some text",
      summary: "a summary",
      engineConfidence: 0.9,
    });

    mockPrisma.client.document.update.mockResolvedValue({});

    mockCopilotIngestion.ingestFromDocumentText.mockRejectedValue(
      new Error("ingestion service down"),
    );

    const result = await registeredJobHandler({
      documentId: "doc-1",
      userId: "user-1",
      category: "BANK_STATEMENT",
    });

    // The OCR job itself still completes successfully (DONE).
    // The bridge failure is swallowed and logged.
    expect(result).toEqual({
      ocrStatus: "DONE",
    });
  });

  it("passes undefined engineConfidence through unchanged when the OCR adapter doesn't report one (e.g. MockOcrAdapter)", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc-1",
      userId: "user-1",
      storageKey: "k1",
      mimeType: "image/png",
      fileName: "statement.png",
    });

    mockStorage.read.mockResolvedValue(Buffer.from("fake"));

    mockOcr.process.mockResolvedValue({
      text: "some text",
      summary: "a summary",
    });

    mockPrisma.client.document.update.mockResolvedValue({});

    await registeredJobHandler({
      documentId: "doc-1",
      userId: "user-1",
      category: "BANK_STATEMENT",
    });

    expect(
      mockCopilotIngestion.ingestFromDocumentText,
    ).toHaveBeenCalledWith(
      "user-1",
      expect.any(String),
      "some text",
      undefined,
      "BANK_TRANSFER",
      "doc-1",
    );
  });
});
