import * as path from "path";
import { createCanvas } from "canvas";
// pdfjs-dist@3.11.174 is the last version with a proper CommonJS `legacy/build` entry
// point — 4.x ships ESM-only (.mjs), which this CommonJS-compiled NestJS app can't
// `require()` directly without adding dynamic import() interop across every call site.
// Verified in this session with a real install + render smoke test before committing
// to this version, not assumed from documentation alone.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

// PROVENANCE NOTE: this exact combination (pdfjs-dist@3.11.174 + canvas@^3.2.3, despite
// pdfjs-dist's own package.json declaring an optional dependency on canvas@^2.11.2) was
// verified end-to-end in this session — a real `npm install`, a real PDF generated with
// pdf-lib, a real page render to a PNG buffer, and a real Tesseract OCR pass over that
// PNG (which correctly failed only on this sandbox's restricted network access to
// Tesseract's language-data CDN, an entirely separate, pre-existing dependency of
// TesseractOcrAdapter, not of this rasterization step). canvas@2.11.2 specifically
// FAILED to install in this environment (no prebuilt binary for this Node/platform
// combination, falls back to a native source build that errors) — canvas@^3.2.3
// installs cleanly with a prebuilt binary and renders correctly despite pdfjs-dist's
// conservative peer declaration. Re-verify this combination against the actual
// deployment target (Render) before shipping — a different Node version or platform
// there could have different prebuilt-binary availability than this sandbox.
//
// DEPLOYMENT RISK, stated honestly: `canvas` is a native addon (bundles/links against
// Cairo). Prebuilt binaries cover the most common Node/OS/arch combinations, but not
// every one — an environment without a matching prebuilt binary falls back to
// compiling from source, which needs Cairo/Pango/JPEG/GIF/librsvg system libraries
// present in the build image. This is a genuinely new class of dependency for this
// codebase (everything else — Tesseract.js, embeddings — is pure JS/WASM,
// specifically to avoid this exact risk). If canvas fails to install or load at
// runtime in a given deployment environment, PDF OCR degrades to
// OcrStatus.NOT_APPLICABLE (see the catch branch in TesseractOcrAdapter) rather than
// crashing document upload entirely — but the underlying capability would be
// unavailable until the environment is fixed.

// Safety cap, mirroring every other numeric bound already established in this codebase
// (loan amortization's 600-month cap, Monte Carlo's iteration/horizon caps, recurring
// transactions' 24-occurrence backfill cap): protects against a pathological or
// maliciously huge PDF (hundreds/thousands of pages) turning one document upload into
// an unbounded amount of rasterization + OCR work. 20 pages comfortably covers the
// realistic documents this app's categories describe (bank statements, salary slips,
// insurance policies, ID documents) — none of which are typically hundreds of pages —
// while still processing genuinely long statements in full.
export const MAX_PDF_PAGES_TO_RASTERIZE = 20;

// Reading the embedded text layer of a digital PDF is cheap (no canvas, no OCR), so it gets a much
// higher cap than rasterization. This lets long e-statements / policy wordings (50-100+ pages) be
// read in full, while scanned pages are still OCR'd only up to MAX_PDF_PAGES_TO_RASTERIZE.
export const MAX_PDF_PAGES_TO_READ_TEXT = 100;

// Render scale: 2.0 (~144 DPI equivalent from a 72-DPI PDF point space) balances OCR
// accuracy (too low and small print becomes unrecognizable) against memory/time cost
// (too high and a single page becomes tens of megabytes) — a reasonable middle ground
// for scanned financial documents, not a value with a precise derivation.
const RENDER_SCALE = 2.0;

// ROOT CAUSE of the production error "Image or Canvas expected" (every PDF OCR job failed all 3
// attempts): pdfjs-dist creates its own intermediate canvases (image masks, patterns, soft masks)
// through its default NodeCanvasFactory, which does `require("canvas")` itself. When the app's
// `canvas` and the copy pdfjs resolves are different installs/versions (npm hoisting on Render),
// the page canvas created HERE is an instance of one module and the intermediate canvases pdfjs
// draws onto it are instances of the other, and node-canvas's drawImage() rejects a foreign object
// with "Image or Canvas expected". Giving pdfjs OUR canvas factory makes every canvas in the
// render come from the same `canvas` module.
class AppCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(target: { canvas: { width: number; height: number } | null }, width: number, height: number) {
    if (!target.canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    target.canvas.width = width;
    target.canvas.height = height;
  }
  destroy(target: { canvas: { width: number; height: number } | null; context: unknown }) {
    if (!target.canvas) return;
    target.canvas.width = 0;
    target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  }
}

// A page whose embedded text layer has fewer characters than this is treated as a scan (or an image-
// only page) and sent to OCR instead.
export const MIN_TEXT_CHARS_FOR_DIGITAL_PAGE = 40;

export class PdfPasswordProtectedError extends Error {
  constructor() {
    super("This PDF is password-protected and cannot be processed without the password.");
    this.name = "PdfPasswordProtectedError";
  }
}

export class PdfCorruptError extends Error {
  constructor(cause: string) {
    super(`This PDF could not be read — it may be corrupted or not a valid PDF file: ${cause}`);
    this.name = "PdfCorruptError";
  }
}

export interface RasterizedPage {
  pageNumber: number;
  pngBuffer: Buffer;
}

export interface RasterizeResult {
  pages: RasterizedPage[];
  /** Pages that could not be rendered (e.g. a canvas/image error on one page) — the rest are still
   * returned so one bad page never throws away a whole statement. */
  failedPages?: Array<{ pageNumber: number; error: string }>;
  totalPages: number; // the PDF's real page count, even if capped below MAX_PDF_PAGES_TO_RASTERIZE
  truncated: boolean; // true when totalPages > pages.length (the cap was hit)
}

// pdfjs-dist needs its own bundled standard font metrics to correctly rasterize text
// that doesn't embed its own font program (common — most PDF generators reference
// standard fonts like Helvetica/Times by name rather than embedding them). Without
// this, rendering silently produces garbled or missing glyphs rather than a clean
// error — confirmed by reproducing exactly that failure mode in this session before
// adding this. Computed lazily (inside rasterizePdfToImages(), not at module-load
// time) so importing this file never does filesystem resolution work unless a caller
// actually rasterizes a PDF.
function standardFontDataUrl(): string {
  return path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + "/";
}

// Rasterizes each page of a PDF (up to MAX_PDF_PAGES_TO_RASTERIZE) into a PNG image
// buffer, ready to hand to TesseractOcrAdapter's existing image-OCR path one page at a
// time. This is the ENTIRE new capability this file adds — everything downstream
// (actual text recognition) reuses the existing, unmodified Tesseract pipeline.
export async function rasterizePdfToImages(pdfBuffer: Buffer, onlyPages?: number[]): Promise<RasterizeResult> {
  const pdfDocument = await openPdf(pdfBuffer);
  try {
    const totalPages = pdfDocument.numPages;
    const wanted = (onlyPages && onlyPages.length > 0 ? onlyPages : Array.from({ length: totalPages }, (_, i) => i + 1))
      .filter((n) => n >= 1 && n <= totalPages)
      .slice(0, MAX_PDF_PAGES_TO_RASTERIZE);
    const pages: RasterizedPage[] = [];
    const failedPages: Array<{ pageNumber: number; error: string }> = [];
    let firstError: unknown = null;

    for (const pageNumber of wanted) {
      try {
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext("2d");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfjs-dist's
        // CanvasRenderingContext2D type expects the DOM lib's type, which the `canvas`
        // package's context is structurally compatible with but not nominally typed as.
        await page.render({ canvasContext: context as any, viewport }).promise;
        pages.push({ pageNumber, pngBuffer: canvas.toBuffer("image/png") });
      } catch (err) {
        firstError = firstError ?? err;
        failedPages.push({ pageNumber, error: (err as Error).message });
      }
    }

    // Nothing rendered at all: surface the real error (so the job is retried / marked FAILED with a
    // cause) instead of pretending the document was empty. Some pages rendering is a partial success.
    if (pages.length === 0 && failedPages.length > 0) throw firstError;

    return {
      pages,
      totalPages,
      truncated: totalPages > wanted.length && !onlyPages,
      ...(failedPages.length > 0 ? { failedPages } : {}),
    };
  } finally {
    await pdfDocument.destroy();
  }
}

export interface PdfTextPage {
  pageNumber: number;
  text: string;
}

// Reads the embedded text layer of every page (up to MAX_PDF_PAGES_TO_READ_TEXT). Digital PDFs (bank
// e-statements, insurance schedules, salary slips) carry real text, which is exact and instant — far
// more accurate than rasterising and OCR-ing it, and it needs no canvas at all. Rows are rebuilt from
// text items by their vertical position, so a statement table keeps one transaction per line.
export async function extractPdfTextPages(pdfBuffer: Buffer): Promise<{ pages: PdfTextPage[]; totalPages: number }> {
  const pdfDocument = await openPdf(pdfBuffer);
  try {
    const totalPages = pdfDocument.numPages;
    const pages: PdfTextPage[] = [];
    for (let pageNumber = 1; pageNumber <= Math.min(totalPages, MAX_PDF_PAGES_TO_READ_TEXT); pageNumber++) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push({ pageNumber, text: textItemsToLines(content.items as PdfTextItem[]) });
    }
    return { pages, totalPages };
  } finally {
    await pdfDocument.destroy();
  }
}

interface PdfTextItem {
  str?: string;
  transform?: number[];
  hasEOL?: boolean;
}

/** Groups text items into lines by their y coordinate (items on the same baseline, within a small
 * tolerance, form one row) and orders each row left to right. Exported for tests. */
export function textItemsToLines(items: PdfTextItem[]): string {
  const rows: Array<{ y: number; parts: Array<{ x: number; str: string }> }> = [];
  for (const item of items) {
    const str = item.str ?? "";
    if (!str.trim()) continue;
    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    const row = rows.find((r) => Math.abs(r.y - y) <= 2.5);
    if (row) row.parts.push({ x, str });
    else rows.push({ y, parts: [{ x, str }] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.str.trim()).join(" ").replace(/\s{2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

async function openPdf(pdfBuffer: Buffer) {
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      standardFontDataUrl: standardFontDataUrl(),
      // Our own canvas factory — see AppCanvasFactory for why this fixes "Image or Canvas expected".
      canvasFactory: new AppCanvasFactory(),
      // No explicit worker configuration needed — pdfjs-dist auto-detects it's running in Node and
      // falls back to synchronous, same-thread ("fake worker") processing automatically.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return await loadingTask.promise;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "PasswordException") {
      throw new PdfPasswordProtectedError();
    }
    if (name === "InvalidPDFException") {
      throw new PdfCorruptError((err as Error).message);
    }
    throw err; // genuinely unexpected — let it surface as a real processing failure
  }
}
