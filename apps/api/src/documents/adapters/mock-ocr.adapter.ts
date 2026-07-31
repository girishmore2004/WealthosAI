import { Injectable, Logger } from "@nestjs/common";
import { OcrAdapter, OcrResult } from "./ocr.adapter";
import { CATEGORY_SUMMARIES } from "./category-summaries";

@Injectable()
export class MockOcrAdapter implements OcrAdapter {
  private readonly logger = new Logger("MockOcrAdapter");

  async process(fileBuffer: Buffer, mimeType: string, category: string): Promise<OcrResult> {
    // Deliberately kept around (not deleted now that TesseractOcrAdapter is the real
    // default) as the explicit, zero-dependency fallback for tests, CI, and any
    // environment where the OCR_ADAPTER=mock env var is set — see
    // ocr-adapter.factory.ts. Returns a deterministic, category-aware placeholder so
    // the rest of the pipeline (status transitions, summary field, expiry-aware
    // alerts) is genuinely exercised end to end without needing a real OCR engine.
    this.logger.log(`[MOCK] OCR run on a ${mimeType} file (${fileBuffer.length} bytes), category=${category}`);
    const summary = CATEGORY_SUMMARIES[category] ?? CATEGORY_SUMMARIES.OTHER;
    return {
      text: `[Mock OCR] Text extraction is not run by this adapter. This document was categorized as ${category}.`,
      summary,
    };
  }
}
