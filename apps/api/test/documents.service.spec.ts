import { Test } from "@nestjs/testing";
import { DocumentsService, MAX_DOCUMENT_SIZE_BYTES } from "../src/documents/documents.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { LocalDiskStorageAdapter } from "../src/documents/adapters/local-disk-storage.adapter";
import { MockOcrAdapter } from "../src/documents/adapters/mock-ocr.adapter";

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
  const mockOcr = { process: jest.fn().mockResolvedValue({ text: "extracted text", summary: "a summary" }) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStorage.save.mockResolvedValue("storage-key-123");
    mockOcr.process.mockResolvedValue({ text: "extracted text", summary: "a summary" });
    mockPrisma.client.document.create.mockResolvedValue({ id: "doc1" });
    mockPrisma.client.document.update.mockImplementation(({ data }) => Promise.resolve({ id: "doc1", ...data }));

    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LocalDiskStorageAdapter, useValue: mockStorage },
        { provide: MockOcrAdapter, useValue: mockOcr },
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

  it("parses a comma-separated tags string into an array and marks OCR as DONE on success", async () => {
    const file = fakeFile();

    await service.upload("user-1", file, { category: "RECEIPT" as never, tags: "grocery, monthly " });

    expect(mockPrisma.client.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tags: ["grocery", "monthly"], ocrStatus: "PENDING" }),
      }),
    );
    expect(mockPrisma.client.document.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ocrStatus: "DONE" }) }),
    );
  });

  it("marks OCR as FAILED rather than throwing if the OCR adapter errors", async () => {
    mockOcr.process.mockRejectedValue(new Error("ocr backend unavailable"));
    const file = fakeFile();

    const result = await service.upload("user-1", file, { category: "OTHER" as never });

    expect(result).toEqual(expect.objectContaining({ ocrStatus: "FAILED" }));
  });
});

describe("DocumentsService.download", () => {
  let service: DocumentsService;
  const mockPrisma = { client: { document: { findUnique: jest.fn() } } };
  const mockStorage = { save: jest.fn(), read: jest.fn(), delete: jest.fn() };
  const mockOcr = { process: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LocalDiskStorageAdapter, useValue: mockStorage },
        { provide: MockOcrAdapter, useValue: mockOcr },
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
