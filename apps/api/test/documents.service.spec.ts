import { Test } from "@nestjs/testing";
import { DocumentsService, MAX_DOCUMENT_SIZE_BYTES } from "../src/documents/documents.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { LocalDiskStorageAdapter } from "../src/documents/adapters/local-disk-storage.adapter";
import { AiQueueService } from "../src/ai/ops/ai-queue.service";
import { DocumentOcrHandler } from "../src/documents/document-ocr.handler";
import { OCR_ADAPTER } from "../src/documents/adapters/ocr-adapter.factory";
import { OcrNotApplicableError } from "../src/documents/adapters/ocr.adapter";

function fakeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "policy.pdf",
    encoding: "7bit",
    mimetype: "application/pdf",
    size: 1024,
    buffer: Buffer.from("test"),
    destination: "",
    filename: "",
    path: "",
    stream: undefined as never,
    ...overrides,
  };
}

describe("DocumentsService.upload", () => {
  let service: DocumentsService;
  const mockPrisma = {
    client: {
      document: { create: jest.fn(), update: jest.fn() },
    },
  };
  const mockStorage = { save: jest.fn().mockResolvedValue("storage-key-123"), read: jest.fn(), delete: jest.fn() };
  const mockAiQueue = { enqueue: jest.fn().mockResolvedValue({ id: "job-1" }) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStorage.save.mockResolvedValue("storage-key-123");
    mockPrisma.client.document.create.mockResolvedValue({ id: "doc1", ocrStatus: "PENDING" });

    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LocalDiskStorageAdapter, useValue: mockStorage },
        { provide: AiQueueService, useValue: mockAiQueue },
      ],
    }).compile();
    service = moduleRef.get(DocumentsService);
  });

  it("rejects a file over the size limit without touching storage", async () => {
    const file = fakeFile({ size: MAX_DOCUMENT_SIZE_BYTES + 1 });

    await expect(service.upload("user-1", file, { category: "OTHER" as never })).rejects.toThrow(/exceeds/i);
    expect(mockStorage.save).not.toHaveBeenCalled();
  });

  it("rejects an unsupported mime type without touching storage", async () => {
    const file = fakeFile({ mimetype: "application/x-executable" });

    await expect(service.upload("user-1", file, { category: "OTHER" as never })).rejects.toThrow(/not supported/i);
    expect(mockStorage.save).not.toHaveBeenCalled();
  });

  it("rejects when no file is present", async () => {
    await expect(
      service.upload("user-1", undefined as never, { category: "OTHER" as never }),
    ).rejects.toThrow(/no file/i);
  });

  it("parses a comma-separated tags string, creates the document as PENDING, and returns immediately without waiting on OCR", async () => {
    const file = fakeFile();

    const result = await service.upload("user-1", file, { category: "RECEIPT" as never, tags: "grocery, monthly " });

    expect(mockPrisma.client.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tags: ["grocery", "monthly"], ocrStatus: "PENDING" }),
      }),
    );
    // No inline document.update call for OCR completion anymore — that now happens
    // asynchronously in DocumentOcrHandler, not on this request path at all.
    expect(mockPrisma.client.document.update).not.toHaveBeenCalled();
    expect(result.ocrStatus).toBe("PENDING");
  });

  it("enqueues an async OCR job scoped to the created document, using its id as the idempotency key", async () => {
    const file = fakeFile({ mimetype: "image/jpeg" });

    await service.upload("user-1", file, { category: "PAN" as never });

    expect(mockAiQueue.enqueue).toHaveBeenCalledWith(
      "document.ocr",
      { documentId: "doc1", userId: "user-1", category: "PAN" },
      { userId: "user-1", idempotencyKey: "doc1" },
    );
  });
});

describe("DocumentsService.download", () => {
  let service: DocumentsService;
  const mockPrisma = { client: { document: { findUnique: jest.fn() } } };
  const mockStorage = { save: jest.fn(), read: jest.fn(), delete: jest.fn() };
  const mockAiQueue = { enqueue: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LocalDiskStorageAdapter, useValue: mockStorage },
        { provide: AiQueueService, useValue: mockAiQueue },
      ],
    }).compile();
    service = moduleRef.get(DocumentsService);
  });

  it("maps a missing backing file (ENOENT) to a 404, not a crash — covers seeded placeholder documents", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc1",
      userId: "user-1",
      storageKey: "seed/local/demo-doc-1.pdf",
      fileName: "demo.pdf",
      mimeType: "application/pdf",
    });
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    mockStorage.read.mockRejectedValue(enoent);

    await expect(service.download("user-1", "doc1")).rejects.toThrow(/could not be found/i);
  });

  it("rejects download for a document owned by a different user", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({ id: "doc1", userId: "someone-else" });

    await expect(service.download("user-1", "doc1")).rejects.toThrow();
    expect(mockStorage.read).not.toHaveBeenCalled();
  });
});

describe("DocumentOcrHandler (new — async OCR processing)", () => {
  let handler: DocumentOcrHandler;
  const mockPrisma = { client: { document: { findUnique: jest.fn(), update: jest.fn() } } };
  const mockStorage = { save: jest.fn(), read: jest.fn(), delete: jest.fn() };
  const mockOcr = { process: jest.fn() };

  // Captures the callback DocumentOcrHandler registers via onModuleInit(), so tests can
  // invoke it directly exactly as the real AiQueueService's worker would when a job is
  // dequeued — without needing a real BullMQ/Redis instance in this unit test.
  let registeredHandler: (input: unknown) => Promise<unknown>;
  const mockAiQueue = {
    registerHandler: jest.fn((_type: string, fn: (input: unknown) => Promise<unknown>) => {
      registeredHandler = fn;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentOcrHandler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LocalDiskStorageAdapter, useValue: mockStorage },
        { provide: OCR_ADAPTER, useValue: mockOcr },
        { provide: AiQueueService, useValue: mockAiQueue },
      ],
    }).compile();
    handler = moduleRef.get(DocumentOcrHandler);
    handler.onModuleInit();
  });

  it("registers a handler for the document.ocr job type", () => {
    expect(mockAiQueue.registerHandler).toHaveBeenCalledWith("document.ocr", expect.any(Function));
  });

  it("on success, reads the file from storage, runs OCR, and marks the document DONE with the extracted text/summary", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc1", userId: "user-1", storageKey: "key-1", mimeType: "image/jpeg",
    });
    mockStorage.read.mockResolvedValue(Buffer.from("fake-image-bytes"));
    mockOcr.process.mockResolvedValue({ text: "PAN 1234", summary: "PAN card summary" });

    const result = await registeredHandler({ documentId: "doc1", userId: "user-1", category: "PAN" });

    expect(mockStorage.read).toHaveBeenCalledWith("key-1");
    expect(mockOcr.process).toHaveBeenCalledWith(Buffer.from("fake-image-bytes"), "image/jpeg", "PAN");
    expect(mockPrisma.client.document.update).toHaveBeenCalledWith({
      where: { id: "doc1" },
      data: { ocrStatus: "DONE", ocrText: "PAN 1234", summary: "PAN card summary" },
    });
    expect(result).toEqual({ ocrStatus: "DONE" });
  });

  it("marks the document NOT_APPLICABLE (not FAILED) when the adapter throws OcrNotApplicableError", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc1", userId: "user-1", storageKey: "key-1", mimeType: "application/pdf",
    });
    mockStorage.read.mockResolvedValue(Buffer.from("fake-pdf-bytes"));
    mockOcr.process.mockRejectedValue(new OcrNotApplicableError("PDFs aren't supported yet"));

    const result = await registeredHandler({ documentId: "doc1", userId: "user-1", category: "OTHER" });

    expect(mockPrisma.client.document.update).toHaveBeenCalledWith({
      where: { id: "doc1" },
      data: { ocrStatus: "NOT_APPLICABLE", summary: "PDFs aren't supported yet" },
    });
    expect(result).toEqual({ ocrStatus: "NOT_APPLICABLE" });
  });

  it("marks the document FAILED and rethrows on a genuine OCR processing error (so the queue's own retry sees it)", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({
      id: "doc1", userId: "user-1", storageKey: "key-1", mimeType: "image/jpeg",
    });
    mockStorage.read.mockResolvedValue(Buffer.from("fake-image-bytes"));
    mockOcr.process.mockRejectedValue(new Error("OCR engine crashed"));

    await expect(registeredHandler({ documentId: "doc1", userId: "user-1", category: "OTHER" })).rejects.toThrow(
      "OCR engine crashed",
    );
    expect(mockPrisma.client.document.update).toHaveBeenCalledWith({
      where: { id: "doc1" },
      data: { ocrStatus: "FAILED" },
    });
  });

  it("skips processing without error when the document was deleted between enqueue and this job running", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue(null);

    const result = await registeredHandler({ documentId: "gone", userId: "user-1", category: "OTHER" });

    expect(result).toEqual({ skipped: true });
    expect(mockStorage.read).not.toHaveBeenCalled();
    expect(mockOcr.process).not.toHaveBeenCalled();
  });

  it("skips processing when the document exists but belongs to a different user than the job claims", async () => {
    mockPrisma.client.document.findUnique.mockResolvedValue({ id: "doc1", userId: "someone-else" });

    const result = await registeredHandler({ documentId: "doc1", userId: "user-1", category: "OTHER" });

    expect(result).toEqual({ skipped: true });
    expect(mockOcr.process).not.toHaveBeenCalled();
  });
});

describe("TesseractOcrAdapter (new — mime-type gate only, no real OCR engine invoked)", () => {
  // Only the synchronous mime-type gate is unit-tested here: it throws
  // OcrNotApplicableError BEFORE ever calling tesseract.js's createWorker(), so this
  // stays a fast, hermetic unit test. Actually exercising the real Tesseract engine
  // (worker startup, language data, image recognition) belongs in a manual/integration
  // QA pass, not this suite — see the QA checklist in the accompanying improvement plan.
  it("throws OcrNotApplicableError for a PDF, without attempting to start a Tesseract worker", async () => {
    const { TesseractOcrAdapter } = await import("../src/documents/adapters/tesseract-ocr.adapter");
    const { OcrNotApplicableError } = await import("../src/documents/adapters/ocr.adapter");
    const adapter = new TesseractOcrAdapter();

    await expect(adapter.process(Buffer.from("pdf-bytes"), "application/pdf", "OTHER")).rejects.toThrow(
      OcrNotApplicableError,
    );
  });

  it("throws OcrNotApplicableError for a Word document", async () => {
    const { TesseractOcrAdapter } = await import("../src/documents/adapters/tesseract-ocr.adapter");
    const { OcrNotApplicableError } = await import("../src/documents/adapters/ocr.adapter");
    const adapter = new TesseractOcrAdapter();

    await expect(
      adapter.process(
        Buffer.from("doc-bytes"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "OTHER",
      ),
    ).rejects.toThrow(OcrNotApplicableError);
  });
});
