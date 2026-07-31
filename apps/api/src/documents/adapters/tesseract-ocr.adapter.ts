import { Injectable, Logger } from "@nestjs/common";
import { createWorker } from "tesseract.js";
import { OcrAdapter, OcrNotApplicableError, OcrResult } from "./ocr.adapter";
import { CATEGORY_SUMMARIES } from "./category-summaries";

// Tesseract.js is a pure-JS/WASM port of the Tesseract OCR engine — free, open-source,
// runs entirely in-process (no external API, no network call, no per-request cost),
// matching the same "zero paid dependency" constraint already applied everywhere else
// in this codebase's AI-adjacent features (Groq for LLM calls, in-process embeddings
// for RAG). This is the audit's explicitly-recommended fix: "Wire in Tesseract.js...
// behind the existing OcrAdapter interface."
//
// SCOPE, stated honestly: Tesseract is an image OCR engine. It does not natively
// extract text from PDFs or Word documents (those would need a separate
// render-to-image or text-layer-extraction step — a meaningfully different pipeline,
// and a bigger addition than fits this change). Only image uploads (JPEG/PNG/WebP —
// the common case for photographed ID documents like PAN/Aadhaar cards, which is
// exactly what most DocumentCategory values here are about) are actually processed;
// anything else throws OcrNotApplicableError, which DocumentOcrHandler maps to the
// existing OcrStatus.NOT_APPLICABLE value rather than a misleading FAILED.
const OCR_SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_SUMMARY_TEXT_CHARS = 400;

@Injectable()
export class TesseractOcrAdapter implements OcrAdapter {
  private readonly logger = new Logger("TesseractOcrAdapter");

  async process(fileBuffer: Buffer, mimeType: string, category: string): Promise<OcrResult> {
    if (!OCR_SUPPORTED_MIME_TYPES.has(mimeType)) {
      throw new OcrNotApplicableError(
        `OCR isn't supported yet for ${mimeType} files — only image uploads (JPEG/PNG/WebP) are text-extracted today.`,
      );
    }

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
        data: { text },
      } = await worker.recognize(fileBuffer);
      const cleanedText = text.trim();
      const categoryLabel = CATEGORY_SUMMARIES[category] ?? CATEGORY_SUMMARIES.OTHER;

      const summary = cleanedText
        ? `${categoryLabel} Extracted text: ${cleanedText.slice(0, MAX_SUMMARY_TEXT_CHARS)}${
            cleanedText.length > MAX_SUMMARY_TEXT_CHARS ? "…" : ""
          }`
        : `${categoryLabel} (No text could be confidently extracted from this image.)`;

      return { text: cleanedText || "(no text detected)", summary };
    } finally {
      // Always terminate the worker, success or failure — a real OCR engine holds a
      // WASM instance + language data in memory; leaking it on every failed job would
      // be a genuine resource leak under sustained upload volume, unlike the mock
      // adapter which has nothing to clean up.
      await worker.terminate();
    }
  }
}
