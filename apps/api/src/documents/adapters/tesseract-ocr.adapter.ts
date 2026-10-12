import { Injectable, Logger } from "@nestjs/common";
import { createWorker } from "tesseract.js";
import { OcrAdapter, OcrNotApplicableError, OcrResult } from "./ocr.adapter";
import { CATEGORY_SUMMARIES } from "./category-summaries";
import {
  MIN_TEXT_CHARS_FOR_DIGITAL_PAGE,
  PdfCorruptError,
  PdfPasswordProtectedError,
  PdfTextPage,
  extractPdfTextPages,
  rasterizePdfToImages,
} from "./pdf-rasterize.util";

// Tesseract.js is a pure-JS/WASM port of the Tesseract OCR engine — free, open-source,
// runs entirely in-process (no external API, no network call, no per-request cost),
// matching the same "zero paid dependency" constraint already applied everywhere else
// in this codebase's AI-adjacent features (Groq for LLM calls, in-process embeddings
// for RAG). This is the audit's explicitly-recommended fix: "Wire in Tesseract.js...
// behind the existing OcrAdapter interface."
//
// PDF SUPPORT (audit item #5, added after the above): PDFs are rasterized to one PNG
// image per page (see pdf-rasterize.util.ts) and each page is run through the exact
// same Tesseract recognition path as a native image upload — no separate PDF-specific
// OCR logic, just a pre-processing step ahead of the same engine. This is genuinely
// new infrastructure with a real, disclosed deployment risk: unlike Tesseract.js and
// this app's other AI-adjacent dependencies, PDF rasterization needs the `canvas`
// native addon (see pdf-rasterize.util.ts's own doc comment for the full detail on
// what was actually verified and what the risk is). Word documents and other
// non-image, non-PDF formats remain unsupported — see the mime-type check below.
const OCR_SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PDF_MIME_TYPE = "application/pdf";
const MAX_SUMMARY_TEXT_CHARS = 400;

@Injectable()
export class TesseractOcrAdapter implements OcrAdapter {
  private readonly logger = new Logger("TesseractOcrAdapter");

  async process(fileBuffer: Buffer, mimeType: string, category: string): Promise<OcrResult> {
    if (mimeType === PDF_MIME_TYPE) {
      return this.processPdf(fileBuffer, category);
    }
    if (!OCR_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new OcrNotApplicableError(
        `OCR isn't supported yet for ${mimeType} files — only image uploads (JPEG/PNG/WebP) and PDFs are text-extracted today.`,
      );
    }

    return this.processImage(fileBuffer, category);
  }

  // NEW (audit item #5): rasterizes each PDF page to an image (see
  // pdf-rasterize.util.ts), runs the exact same Tesseract recognition on each page
  // image via processImage() below, and concatenates the results with a clear
  // page-boundary marker. A single Tesseract worker is reused across all pages of one
  // PDF (created once, terminated once) rather than one worker per page — the same
  // "simple, correct, off-the-request-path" tradeoff processImage()'s own doc comment
  // already accepts for the single-image case, just amortized across a handful of
  // pages instead of one call.
  private async processPdf(pdfBuffer: Buffer, category: string): Promise<OcrResult> {
    // STEP 1 — embedded text layer. Digital PDFs (e-statements, policy schedules, salary slips) carry
    // exact text; reading it is instant, free and far more accurate than OCR, and it needs no canvas.
    let digital: { pages: PdfTextPage[]; totalPages: number } | null = null;
    try {
      digital = await extractPdfTextPages(pdfBuffer);
    } catch (err) {
      if (err instanceof PdfPasswordProtectedError) {
        // Not something OCR can work around — "not applicable", not a retryable failure.
        throw new OcrNotApplicableError(err.message);
      }
      // Anything else (corrupt file, unexpected pdfjs error) is not decided here: the rasterize step
      // below re-opens the file and reports the authoritative error type.
      this.logger.warn(`PDF text-layer extraction failed, falling back to OCR: ${(err as Error).message}`);
    }

    const digitalByPage = new Map<number, string>();
    for (const p of digital?.pages ?? []) {
      if (p.text.trim().length >= MIN_TEXT_CHARS_FOR_DIGITAL_PAGE) digitalByPage.set(p.pageNumber, p.text.trim());
    }
    const totalPages = digital?.totalPages ?? 0;
    const pageCount = digital?.pages.length ?? 0;
    const scannedPageNumbers = digital ? digital.pages.map((p) => p.pageNumber).filter((n) => !digitalByPage.has(n)) : [];

    // STEP 2 — OCR only the pages that have no usable text layer (all pages when the text layer could not
    // be read at all).
    let ocrPages: Array<{ pageNumber: number; text: string; confidence: number }> = [];
    let ocrTruncated = false;
    let ocrTotalPages = totalPages;
    let ocrFailureNote = "";
    if (!digital || scannedPageNumbers.length > 0) {
      let rasterized;
      try {
        rasterized = digital ? await rasterizePdfToImages(pdfBuffer, scannedPageNumbers) : await rasterizePdfToImages(pdfBuffer);
      } catch (err) {
        if (err instanceof PdfPasswordProtectedError) throw new OcrNotApplicableError(err.message);
        if (err instanceof PdfCorruptError) throw err; // a re-upload of a valid copy could succeed
        if (digitalByPage.size === 0) throw err; // nothing usable at all: a real failure worth retrying
        // Some pages already have exact text: keep them and say honestly that the rest could not be read.
        this.logger.warn(`PDF page rasterization failed; keeping digital text only: ${(err as Error).message}`);
        ocrFailureNote = ` ${scannedPageNumbers.length} scanned page(s) could not be OCR'd.`;
        rasterized = null;
      }

      if (rasterized) {
        if (rasterized.pages.length === 0 && digitalByPage.size === 0) {
          throw new OcrNotApplicableError("This PDF has no pages to extract text from.");
        }
        ocrTotalPages = rasterized.totalPages;
        ocrTruncated = rasterized.truncated;
        if (rasterized.failedPages?.length) {
          ocrFailureNote = ` Page(s) ${rasterized.failedPages.map((f) => f.pageNumber).join(", ")} could not be OCR'd.`;
        }
        if (rasterized.pages.length > 0) {
          const worker = await createWorker("eng");
          try {
            for (const page of rasterized.pages) {
              const {
                data: { text, confidence },
              } = await worker.recognize(page.pngBuffer);
              ocrPages.push({ pageNumber: page.pageNumber, text: text.trim(), confidence: Math.max(0, Math.min(1, confidence / 100)) });
            }
          } finally {
            await worker.terminate();
          }
        }
      }
    }

    // STEP 3 — merge in page order. Digital pages count as near-certain (0.99), OCR pages carry
    // Tesseract's own confidence; the document-level confidence is the mean over pages with text.
    const merged = new Map<number, { text: string; confidence: number; source: "text" | "ocr" }>();
    for (const [pageNumber, text] of digitalByPage) merged.set(pageNumber, { text, confidence: 0.99, source: "text" });
    for (const p of ocrPages) merged.set(p.pageNumber, { text: p.text, confidence: p.confidence, source: "ocr" });
    const ordered = [...merged.entries()].sort((a, b) => a[0] - b[0]);
    if (ordered.length === 0) {
      throw new OcrNotApplicableError("This PDF has no pages to extract text from.");
    }

    const engineConfidence = ordered.reduce((sum, [, v]) => sum + v.confidence, 0) / ordered.length;
    const combinedText = ordered
      .map(([n, v]) => `--- Page ${n} ---\n${v.text || "(no text detected on this page)"}`)
      .join("\n\n");

    const categoryLabel = CATEGORY_SUMMARIES[category] ?? CATEGORY_SUMMARIES.OTHER;
    const flatText = ordered.map(([, v]) => v.text).filter(Boolean).join(" ");
    const shownPages = ordered.length;
    const knownTotal = Math.max(totalPages, ocrTotalPages, pageCount);
    const truncationNote =
      ocrTruncated || knownTotal > shownPages
        ? ` (showing the first ${shownPages} of ${knownTotal} pages)`
        : "";
    const digitalNote = digitalByPage.size > 0 ? ` ${digitalByPage.size} page(s) were read directly from the PDF text.` : "";
    const summary = flatText
      ? `${categoryLabel} Extracted text from ${shownPages}-page PDF${truncationNote}:${digitalNote}${ocrFailureNote} ${flatText.slice(0, MAX_SUMMARY_TEXT_CHARS)}${flatText.length > MAX_SUMMARY_TEXT_CHARS ? "…" : ""}`
      : `${categoryLabel} (No text could be confidently extracted from this ${shownPages}-page PDF.)`;

    return { text: combinedText, summary, engineConfidence };
  }

  // The original, unmodified single-image recognition path — image uploads (JPEG/PNG/
  // WebP) and each rasterized PDF page both go through this exact same method, so
  // there is one implementation of "how Tesseract is actually invoked," not two.
  private async processImage(fileBuffer: Buffer, category: string): Promise<OcrResult> {
    // A fresh worker per call (rather than a long-lived pooled worker) is deliberately
    // simple and correct for this app's volume: OCR now runs off the request path via
    // DocumentOcrHandler/AiQueueService, so a few hundred milliseconds of worker
    // startup overhead per job is not user-facing latency. Pooling workers would be a
    // reasonable follow-up optimization if OCR volume ever became high enough for
    // startup cost to matter, but would add real complexity (worker lifecycle,
    // concurrency limits) not justified yet.
    const worker = await createWorker("eng");
    try {
      const {
        data: { text, confidence },
      } = await worker.recognize(fileBuffer);
      const cleanedText = text.trim();
      const categoryLabel = CATEGORY_SUMMARIES[category] ?? CATEGORY_SUMMARIES.OTHER;

      const summary = cleanedText
        ? `${categoryLabel} Extracted text: ${cleanedText.slice(0, MAX_SUMMARY_TEXT_CHARS)}${
            cleanedText.length > MAX_SUMMARY_TEXT_CHARS ? "…" : ""
          }`
        : `${categoryLabel} (No text could be confidently extracted from this image.)`;

      return {
        text: cleanedText || "(no text detected)",
        summary,
        engineConfidence: Math.max(0, Math.min(1, confidence / 100)),
      };
    } finally {
      // Always terminate the worker, success or failure — a real OCR engine holds a
      // WASM instance + language data in memory; leaking it on every failed job would
      // be a genuine resource leak under sustained upload volume, unlike the mock
      // adapter which has nothing to clean up.
      await worker.terminate();
    }
  }
}
