import { Test } from "@nestjs/testing";
import { DocumentOcrHandler } from "../src/documents/document-ocr.handler";
import { AiQueueService } from "../src/ai/ops/ai-queue.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { LocalDiskStorageAdapter } from "../src/documents/adapters/local-disk-storage.adapter";
import { OCR_ADAPTER } from "../src/documents/adapters/ocr-adapter.factory";
import { OcrNotApplicableError } from "../src/documents/adapters/ocr.adapter";
import { RagAutoReindexService } from "../src/ai/ops/rag-auto-reindex.service";

describe("DocumentOcrHandler RAG auto-reindex trigger (new, audit item #7)", () => {
  let handler: DocumentOcrHandler;
  let registeredJobHandler: (input: unknown) => Promise<unknown>;

  const mockQueue = {
    registerHandler: jest.fn((_type: string, fn: (input: unknown) => Promise<unknown>) => {
      registeredJobHandler = fn;
    }),
  };
  const mockPrisma = { client: { document: { findUnique: jest.fn(), update: jest.fn() } } };
  const mockStorage = { read: jest.fn() };
  const mockOcr = { process: jest.fn() };
  const mockRagAutoReindex = { triggerFor: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentOcrHandler,
        { provide: AiQueueService, useValue: mockQueue },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LocalDiskStorageAdapter, useValue: mockStorage },
        { provide: OCR_ADAPTER, useValue: mockOcr },
        { provide: RagAutoReindexService, useValue: mockRagAutoReindex },
      ],
    }).compile();
    handler = moduleRef.get(DocumentOcrHandler);
    handler.onModuleInit(); // registers the job handler, capturing it via the mock above
  });

  it("triggers a reindex after a successful DONE OCR result", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({ id: "doc-1", userId: "user-1", storageKey: "k1", mimeType: "image/png" });
    mockStorage.read.mockResolvedValue(Buffer.from("fake"));
    mockOcr.process.mockResolvedValue({ text: "extracted text", summary: "a summary" });
    mockPrisma.client.document.update.mockResolvedValue({});

    await registeredJobHandler({ documentId: "doc-1", userId: "user-1", category: "BANK_STATEMENT" });

    expect(mockRagAutoReindex.triggerFor).toHaveBeenCalledWith("user-1");
  });

  it("triggers a reindex after a NOT_APPLICABLE result (metadata is still new, indexable content)", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({ id: "doc-1", userId: "user-1", storageKey: "k1", mimeType: "application/msword" });
    mockStorage.read.mockResolvedValue(Buffer.from("fake"));
    mockOcr.process.mockRejectedValue(new OcrNotApplicableError("Word documents are not supported"));
    mockPrisma.client.document.update.mockResolvedValue({});

    await registeredJobHandler({ documentId: "doc-1", userId: "user-1", category: "OTHER" });

    expect(mockRagAutoReindex.triggerFor).toHaveBeenCalledWith("user-1");
  });

  it("does NOT trigger a reindex when OCR genuinely fails (no new indexable content)", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({ id: "doc-1", userId: "user-1", storageKey: "k1", mimeType: "image/png" });
    mockStorage.read.mockResolvedValue(Buffer.from("fake"));
    mockOcr.process.mockRejectedValue(new Error("OCR engine crashed"));
    mockPrisma.client.document.update.mockResolvedValue({});

    await expect(registeredJobHandler({ documentId: "doc-1", userId: "user-1", category: "OTHER" })).rejects.toThrow(
      "OCR engine crashed",
    );

    expect(mockRagAutoReindex.triggerFor).not.toHaveBeenCalled();
  });

  it("does not trigger a reindex when the document was deleted before the job ran", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue(null);

    await registeredJobHandler({ documentId: "doc-1", userId: "user-1", category: "OTHER" });

    expect(mockRagAutoReindex.triggerFor).not.toHaveBeenCalled();
    expect(mockOcr.process).not.toHaveBeenCalled();
  });
});
