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

// Render scale: 2.0 (~144 DPI equivalent from a 72-DPI PDF point space) balances OCR
// accuracy (too low and small print becomes unrecognizable) against memory/time cost
// (too high and a single page becomes tens of megabytes) — a reasonable middle ground
// for scanned financial documents, not a value with a precise derivation.
const RENDER_SCALE = 2.0;

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
export async function rasterizePdfToImages(pdfBuffer: Buffer): Promise<RasterizeResult> {
  let pdfDocument;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      standardFontDataUrl: standardFontDataUrl(),
      // No explicit worker configuration needed — pdfjs-dist auto-detects it's
      // running in Node (no Web Worker global available) and falls back to
      // synchronous, same-thread ("fake worker") processing automatically. This
      // already runs off the request path inside DocumentOcrHandler/AiQueueService's
      // own job processing, matching how TesseractOcrAdapter's worker-per-call is
      // deliberately simple for the same reason (see that file's own doc comment).
    });
    pdfDocument = await loadingTask.promise;
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

  const totalPages = pdfDocument.numPages;
  const pagesToRender = Math.min(totalPages, MAX_PDF_PAGES_TO_RASTERIZE);
  const pages: RasterizedPage[] = [];

  for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber++) {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfjs-dist's
    // CanvasRenderingContext2D type expects the DOM lib's type, which the `canvas`
    // package's context is structurally compatible with but not nominally typed as.
    await page.render({ canvasContext: context as any, viewport }).promise;

    pages.push({ pageNumber, pngBuffer: canvas.toBuffer("image/png") });
  }

  await pdfDocument.destroy();

  return { pages, totalPages, truncated: totalPages > pagesToRender };
}
