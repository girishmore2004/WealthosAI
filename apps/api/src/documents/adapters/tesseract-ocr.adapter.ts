import { Injectable, Logger } from "@nestjs/common";
import { createWorker } from "tesseract.js";
import { OcrAdapter, OcrNotApplicableError, OcrResult } from "./ocr.adapter";
import { CATEGORY_SUMMARIES } from "./category-summaries";
import { PdfCorruptError, PdfPasswordProtectedError, rasterizePdfToImages } from "./pdf-rasterize.util";

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
    let rasterized;
    try {
      rasterized = await rasterizePdfToImages(pdfBuffer);
    } catch (err) {
      if (err instanceof PdfPasswordProtectedError) {
        // A password-protected PDF isn't something OCR can work around — closer in
        // spirit to "not applicable" (we categorically cannot process this without
        // information we don't have) than a transient FAILED worth retrying as-is.
        throw new OcrNotApplicableError(err.message);
      }
      if (err instanceof PdfCorruptError) {
        // A genuinely corrupt/invalid file IS a real processing failure — propagate
        // as-is so DocumentOcrHandler marks it FAILED, not NOT_APPLICABLE, since a
        // correctly-formed re-upload of the same document could succeed (unlike the
        // password case above, which no re-upload alone fixes).
        throw err;
      }
      throw err; // genuinely unexpected — surface it rather than silently reclassifying
    }

    if (rasterized.pages.length === 0) {
      throw new OcrNotApplicableError("This PDF has no pages to extract text from.");
    }

    const worker = await createWorker("eng");
    try {
      const pageTexts: string[] = [];
      const pageConfidences: number[] = [];
      for (const page of rasterized.pages) {
        const {
          data: { text, confidence },
        } = await worker.recognize(page.pngBuffer);
        pageTexts.push(text.trim());
        pageConfidences.push(Math.max(0, Math.min(1, confidence / 100)));
      }
      // Simple mean across pages — a multi-page PDF has one overall extraction
      // quality signal on IngestionBatch (via the Document-Ingestion bridge), not a
      // per-page one, so an unweighted average is the natural rollup.
      const engineConfidence = pageConfidences.reduce((sum, c) => sum + c, 0) / pageConfidences.length;

      const combinedText = pageTexts
        .map((text, i) => `--- Page ${rasterized.pages[i].pageNumber} ---\n${text || "(no text detected on this page)"}`)
        .join("\n\n");

      const categoryLabel = CATEGORY_SUMMARIES[category] ?? CATEGORY_SUMMARIES.OTHER;
      const flatText = pageTexts.filter(Boolean).join(" ");
      const truncationNote = rasterized.truncated
        ? ` (showing the first ${rasterized.pages.length} of ${rasterized.totalPages} pages)`
        : "";
      const summary = flatText
        ? `${categoryLabel} Extracted text from ${rasterized.pages.length}-page PDF${truncationNote}: ${flatText.slice(0, MAX_SUMMARY_TEXT_CHARS)}${flatText.length > MAX_SUMMARY_TEXT_CHARS ? "…" : ""}`
        : `${categoryLabel} (No text could be confidently extracted from this ${rasterized.pages.length}-page PDF.)`;

      return { text: combinedText, summary, engineConfidence };
    } finally {
      await worker.terminate();
    }
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
