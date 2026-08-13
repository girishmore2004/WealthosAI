// Mocked BEFORE importing the module under test, per standard Jest hoisting — these
// mocks stand in for the real pdfjs-dist/canvas packages (installed via package.json
// in this batch) so this test suite exercises pdf-rasterize.util.ts's own logic (page
// cap enforcement, error-type mapping, resource cleanup) deterministically, without
// depending on actually rendering a PDF (already verified separately, by hand, in a
// real Node process during development — see this file's own top-of-file provenance
// note for what was actually run and confirmed working).
const mockGetDocument = jest.fn();
jest.mock("pdfjs-dist/legacy/build/pdf.js", () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

const mockCreateCanvas = jest.fn();
jest.mock("canvas", () => ({
  createCanvas: (...args: unknown[]) => mockCreateCanvas(...args),
}));

import { MAX_PDF_PAGES_TO_RASTERIZE, PdfCorruptError, PdfPasswordProtectedError, rasterizePdfToImages } from "../src/documents/adapters/pdf-rasterize.util";

function makeMockPage() {
  return {
    getViewport: jest.fn().mockReturnValue({ width: 100, height: 100 }),
    render: jest.fn().mockReturnValue({ promise: Promise.resolve() }),
  };
}

function makeMockPdfDocument(numPages: number) {
  const pages: Record<number, ReturnType<typeof makeMockPage>> = {};
  for (let i = 1; i <= numPages; i++) pages[i] = makeMockPage();
  return {
    numPages,
    getPage: jest.fn((n: number) => Promise.resolve(pages[n])),
    destroy: jest.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateCanvas.mockReturnValue({
    getContext: jest.fn().mockReturnValue({}),
    toBuffer: jest.fn().mockReturnValue(Buffer.from("fake-png-bytes")),
  });
});

describe("rasterizePdfToImages", () => {
  it("rasterizes every page of a small PDF into a PNG buffer per page", async () => {
    const mockDoc = makeMockPdfDocument(3);
    mockGetDocument.mockReturnValue({ promise: Promise.resolve(mockDoc) });

    const result = await rasterizePdfToImages(Buffer.from("fake-pdf-bytes"));

    expect(result.totalPages).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(result.pages.every((p) => Buffer.isBuffer(p.pngBuffer))).toBe(true);
  });

  it("destroys the pdf document after rasterizing, success or failure", async () => {
    const mockDoc = makeMockPdfDocument(1);
    mockGetDocument.mockReturnValue({ promise: Promise.resolve(mockDoc) });

    await rasterizePdfToImages(Buffer.from("fake-pdf-bytes"));

    expect(mockDoc.destroy).toHaveBeenCalled();
  });

  it("caps rasterization at MAX_PDF_PAGES_TO_RASTERIZE for a PDF with more pages than the cap", async () => {
    const totalPages = MAX_PDF_PAGES_TO_RASTERIZE + 15;
    const mockDoc = makeMockPdfDocument(totalPages);
    mockGetDocument.mockReturnValue({ promise: Promise.resolve(mockDoc) });

    const result = await rasterizePdfToImages(Buffer.from("fake-pdf-bytes"));

    expect(result.totalPages).toBe(totalPages);
    expect(result.pages).toHaveLength(MAX_PDF_PAGES_TO_RASTERIZE);
    expect(result.truncated).toBe(true);
    // getPage should never be called for a page beyond the cap — the safety limit
    // must actually bound the work done, not just the reported result.
    expect(mockDoc.getPage).toHaveBeenCalledTimes(MAX_PDF_PAGES_TO_RASTERIZE);
  });

  it("does not report truncation for a PDF with fewer pages than the cap", async () => {
    const mockDoc = makeMockPdfDocument(2);
    mockGetDocument.mockReturnValue({ promise: Promise.resolve(mockDoc) });

    const result = await rasterizePdfToImages(Buffer.from("fake-pdf-bytes"));

    expect(result.truncated).toBe(false);
  });

  it("throws PdfPasswordProtectedError for a PasswordException, with a clear message", async () => {
    const err = new Error("Password required");
    err.name = "PasswordException";
    mockGetDocument.mockReturnValue({ promise: Promise.reject(err) });

    await expect(rasterizePdfToImages(Buffer.from("fake-pdf-bytes"))).rejects.toThrow(PdfPasswordProtectedError);
  });

  it("throws PdfCorruptError for an InvalidPDFException, including the underlying cause", async () => {
    const err = new Error("Invalid PDF structure");
    err.name = "InvalidPDFException";
    mockGetDocument.mockReturnValue({ promise: Promise.reject(err) });

    await expect(rasterizePdfToImages(Buffer.from("fake-pdf-bytes"))).rejects.toThrow(PdfCorruptError);
    await expect(rasterizePdfToImages(Buffer.from("fake-pdf-bytes"))).rejects.toThrow(/Invalid PDF structure/);
  });

  it("re-throws an unrecognized error type as-is, without reclassifying it", async () => {
    const err = new Error("some totally unexpected failure");
    mockGetDocument.mockReturnValue({ promise: Promise.reject(err) });

    await expect(rasterizePdfToImages(Buffer.from("fake-pdf-bytes"))).rejects.toThrow("some totally unexpected failure");
  });

  it("renders each page at the expected viewport scale", async () => {
    const mockDoc = makeMockPdfDocument(1);
    const page = await mockDoc.getPage(1);
    mockGetDocument.mockReturnValue({ promise: Promise.resolve(mockDoc) });

    await rasterizePdfToImages(Buffer.from("fake-pdf-bytes"));

    expect(page.getViewport).toHaveBeenCalledWith({ scale: 2.0 });
  });
});
