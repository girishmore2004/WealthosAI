export interface OcrResult {
  text: string;
  summary: string;
}

// Abstracts text extraction + summarization for an uploaded document. Swap the
// implementation behind this interface without touching DocumentsService, the DB
// schema, or the upload flow — see ocr-adapter.factory.ts for how the concrete
// implementation is selected (TesseractOcrAdapter by default, MockOcrAdapter via
// OCR_ADAPTER=mock).
export interface OcrAdapter {
  process(fileBuffer: Buffer, mimeType: string, category: string): Promise<OcrResult>;
}

// Thrown by an adapter when a file's mime type genuinely isn't something OCR applies
// to (e.g. a Word document — no image/text layer to run recognition against) — distinct
// from a real processing failure (a corrupt image, an OCR engine crash). DocumentOcrHandler
// catches this specifically and marks the document's ocrStatus as NOT_APPLICABLE (an
// existing, already-correct enum value for exactly this case) rather than FAILED, which
// would incorrectly suggest something went wrong and might be worth retrying.
export class OcrNotApplicableError extends Error {}
