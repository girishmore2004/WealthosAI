const mockRecognize = jest.fn();
const mockTerminate = jest.fn().mockResolvedValue(undefined);
const mockCreateWorker = jest.fn().mockResolvedValue({ recognize: mockRecognize, terminate: mockTerminate });
jest.mock("tesseract.js", () => ({
  createWorker: (...args: unknown[]) => mockCreateWorker(...args),
}));

const mockRasterizePdfToImages = jest.fn();
jest.mock("../src/documents/adapters/pdf-rasterize.util", () => {
  const actual = jest.requireActual("../src/documents/adapters/pdf-rasterize.util");
  return {
    ...actual,
    rasterizePdfToImages: (...args: unknown[]) => mockRasterizePdfToImages(...args),
  };
});

import { TesseractOcrAdapter } from "../src/documents/adapters/tesseract-ocr.adapter";
import { OcrNotApplicableError } from "../src/documents/adapters/ocr.adapter";
import { PdfCorruptError, PdfPasswordProtectedError } from "../src/documents/adapters/pdf-rasterize.util";

describe("TesseractOcrAdapter PDF support (new, audit item #5)", () => {
  let adapter: TesseractOcrAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateWorker.mockResolvedValue({ recognize: mockRecognize, terminate: mockTerminate });
    adapter = new TesseractOcrAdapter();
  });

  it("routes application/pdf uploads to the PDF path, not the unsupported-type rejection", async () => {
    mockRasterizePdfToImages.mockResolvedValue({
      pages: [{ pageNumber: 1, pngBuffer: Buffer.from("page1") }],
      totalPages: 1,
      truncated: false,
    });
    mockRecognize.mockResolvedValue({ data: { text: "Statement content" } });

    const result = await adapter.process(Buffer.from("fake-pdf"), "application/pdf", "MF_STATEMENT");

    expect(mockRasterizePdfToImages).toHaveBeenCalledWith(Buffer.from("fake-pdf"));
    expect(result.text).toContain("Statement content");
  });

  it("concatenates text from every page with a clear page-boundary marker", async () => {
    mockRasterizePdfToImages.mockResolvedValue({
      pages: [
        { pageNumber: 1, pngBuffer: Buffer.from("page1") },
        { pageNumber: 2, pngBuffer: Buffer.from("page2") },
      ],
      totalPages: 2,
      truncated: false,
    });
    mockRecognize
      .mockResolvedValueOnce({ data: { text: "First page text" } })
      .mockResolvedValueOnce({ data: { text: "Second page text" } });

    const result = await adapter.process(Buffer.from("fake-pdf"), "application/pdf", "OTHER");

    expect(result.text).toContain("--- Page 1 ---");
    expect(result.text).toContain("First page text");
    expect(result.text).toContain("--- Page 2 ---");
    expect(result.text).toContain("Second page text");
  });

  it("reuses a single Tesseract worker across all pages instead of creating one per page", async () => {
    mockRasterizePdfToImages.mockResolvedValue({
      pages: [
        { pageNumber: 1, pngBuffer: Buffer.from("page1") },
        { pageNumber: 2, pngBuffer: Buffer.from("page2") },
        { pageNumber: 3, pngBuffer: Buffer.from("page3") },
      ],
      totalPages: 3,
      truncated: false,
    });
    mockRecognize.mockResolvedValue({ data: { text: "text" } });

    await adapter.process(Buffer.from("fake-pdf"), "application/pdf", "OTHER");

    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
    expect(mockRecognize).toHaveBeenCalledTimes(3);
    expect(mockTerminate).toHaveBeenCalledTimes(1);
  });

  it("terminates the worker even if recognition fails partway through", async () => {
    mockRasterizePdfToImages.mockResolvedValue({
      pages: [{ pageNumber: 1, pngBuffer: Buffer.from("page1") }],
      totalPages: 1,
      truncated: false,
    });
    mockRecognize.mockRejectedValue(new Error("OCR engine crashed"));

    await expect(adapter.process(Buffer.from("fake-pdf"), "application/pdf", "OTHER")).rejects.toThrow(
      "OCR engine crashed",
    );

    expect(mockTerminate).toHaveBeenCalledTimes(1);
  });

  it("notes truncation in the summary when the PDF exceeded the page cap", async () => {
    mockRasterizePdfToImages.mockResolvedValue({
      pages: [{ pageNumber: 1, pngBuffer: Buffer.from("page1") }],
      totalPages: 50,
      truncated: true,
    });
    mockRecognize.mockResolvedValue({ data: { text: "some text" } });

    const result = await adapter.process(Buffer.from("fake-pdf"), "application/pdf", "OTHER");

    expect(result.summary).toMatch(/first 1 of 50 pages/i);
  });

  it("maps PdfPasswordProtectedError to OcrNotApplicableError", async () => {
    mockRasterizePdfToImages.mockRejectedValue(new PdfPasswordProtectedError());

    await expect(adapter.process(Buffer.from("fake-pdf"), "application/pdf", "OTHER")).rejects.toThrow(
      OcrNotApplicableError,
    );
  });

  it("propagates PdfCorruptError as-is (a real failure, not 'not applicable')", async () => {
    mockRasterizePdfToImages.mockRejectedValue(new PdfCorruptError("bad structure"));

    await expect(adapter.process(Buffer.from("fake-pdf"), "application/pdf", "OTHER")).rejects.toThrow(
      PdfCorruptError,
    );
  });

  it("throws OcrNotApplicableError for a PDF with zero pages", async () => {
    mockRasterizePdfToImages.mockResolvedValue({ pages: [], totalPages: 0, truncated: false });

    await expect(adapter.process(Buffer.from("fake-pdf"), "application/pdf", "OTHER")).rejects.toThrow(
      OcrNotApplicableError,
    );
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it("still rejects genuinely unsupported mime types (e.g. Word documents) — PDF support doesn't loosen this", async () => {
    await expect(adapter.process(Buffer.from("fake"), "application/msword", "OTHER")).rejects.toThrow(
      OcrNotApplicableError,
    );
    expect(mockRasterizePdfToImages).not.toHaveBeenCalled();
  });

  it("still processes plain images (JPEG/PNG/WebP) exactly as before, bypassing the PDF path entirely", async () => {
    mockRecognize.mockResolvedValue({ data: { text: "image text" } });

    const result = await adapter.process(Buffer.from("fake-image"), "image/png", "OTHER");

    expect(mockRasterizePdfToImages).not.toHaveBeenCalled();
    expect(result.text).toBe("image text");
  });
});
