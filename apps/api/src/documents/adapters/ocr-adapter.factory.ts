import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { TesseractOcrAdapter } from "./tesseract-ocr.adapter";
import { MockOcrAdapter } from "./mock-ocr.adapter";
import { OcrAdapter } from "./ocr.adapter";

export const OCR_ADAPTER = "OCR_ADAPTER";

const logger = new Logger("OcrAdapterFactory");

// Mirrors auth/adapters/otp-adapter.factory.ts's exact pattern: OCR_ADAPTER=tesseract
// (default) selects the real, free/OSS Tesseract.js adapter; OCR_ADAPTER=mock keeps the
// deterministic zero-dependency placeholder for tests/CI or an environment that
// deliberately wants to skip real OCR processing. An unrecognized value fails safe to
// the mock adapter (with a warning) rather than crashing the app on a typo'd env var.
export function ocrAdapterFactory(
  config: ConfigService,
  tesseractAdapter: TesseractOcrAdapter,
  mockAdapter: MockOcrAdapter,
): OcrAdapter {
  const selected = config.get<string>("ocrAdapter");
  switch (selected) {
    case "mock":
      return mockAdapter;
    case "tesseract":
    case undefined:
      return tesseractAdapter;
    default:
      logger.warn(`Unknown OCR_ADAPTER "${selected}" — falling back to the mock adapter.`);
      return mockAdapter;
  }
}
