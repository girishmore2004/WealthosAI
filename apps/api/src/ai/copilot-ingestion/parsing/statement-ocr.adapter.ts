import { Injectable, Logger } from "@nestjs/common";
import { createWorker } from "tesseract.js";
import { OCR_SUPPORTED_MIME_TYPES } from "../copilot-ingestion.constants";

export interface StatementOcrResult {
  text: string;
  /** Tesseract's own reported mean word-confidence for this recognition, 0-100,
   * converted to 0-1 here. Passed through to OcrQualityEstimationService as one input
   * signal among several — see that class for why the engine's self-reported number
   * alone isn't trusted as the final "extraction confidence." */
  engineConfidence: number;
}

export class UnsupportedStatementImageError extends Error {}

// Deliberately a SEPARATE, self-contained Tesseract.js wrapper from
// documents/adapters/tesseract-ocr.adapter.ts rather than a reuse of that adapter or
// its OCR_ADAPTER DI token. Two reasons, both real:
//  1. DocumentsModule does not export OCR_ADAPTER (only DocumentsService) — importing
//     it here would require widening that module's exports for a single-feature need,
//     the same tradeoff copilot-ingestion.module.ts already documents choosing against
//     for AnomalyDetectionModel (cheaper/safer to duplicate a small, dependency-light
//     class than to change another feature's module surface).
//  2. The two use cases genuinely want different output shapes: Documents' OcrAdapter
//     returns {text, summary} for a document viewer; statement ingestion needs the
//     engine's numeric confidence score (for OcrQualityEstimationService) instead of a
//     prose summary, and never needs a summary at all.
// This does mean tesseract.js's worker lifecycle logic is duplicated between the two
// adapters — an accepted, explicitly-documented tradeoff, not an oversight.
@Injectable()
export class StatementOcrAdapter {
  private readonly logger = new Logger(StatementOcrAdapter.name);

  async process(fileBuffer: Buffer, mimeType: string): Promise<StatementOcrResult> {
    if (!OCR_SUPPORTED_MIME_TYPES.has(mimeType)) {
      throw new UnsupportedStatementImageError(
        `Statement OCR only supports photographed/scanned pages as JPEG, PNG, or WebP images — received "${mimeType}".`,
      );
    }

    // Fresh worker per call — OCR here runs off a rate-limited, already-expensive
    // controller route (same reasoning TesseractOcrAdapter documents for Documents
    // uploads), so per-call startup overhead is an acceptable, simple tradeoff against
    // the real complexity of a pooled-worker lifecycle.
    const worker = await createWorker("eng");
    try {
      const {
        data: { text, confidence },
      } = await worker.recognize(fileBuffer);
      return { text: text.trim(), engineConfidence: Math.max(0, Math.min(1, confidence / 100)) };
    } finally {
      await worker.terminate();
    }
  }
}
