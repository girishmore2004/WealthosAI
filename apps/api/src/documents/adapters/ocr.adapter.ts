export interface OcrResult {
  text: string;
  summary: string;
}

// Abstracts text extraction + summarization for an uploaded document. The mock
// implementation below returns a deterministic, category-aware placeholder — swap it
// for a real OCR/vision pipeline later behind this same interface without touching
// DocumentsService, the DB schema, or the upload flow.
export interface OcrAdapter {
  process(fileBuffer: Buffer, mimeType: string, category: string): Promise<OcrResult>;
}
