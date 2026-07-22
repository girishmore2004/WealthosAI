import { Injectable, Logger } from "@nestjs/common";
import { OcrAdapter, OcrResult } from "./ocr.adapter";

const CATEGORY_SUMMARIES: Record<string, string> = {
  PAN: "PAN card on file for identity/tax verification.",
  AADHAAR: "Aadhaar card on file for identity verification.",
  SALARY_SLIP: "Salary slip — useful for income verification and loan applications.",
  FORM_16: "Form 16 — TDS certificate, needed for annual tax filing.",
  INSURANCE_POLICY: "Insurance policy document — check coverage terms and renewal date.",
  LOAN_DOCUMENT: "Loan agreement or statement.",
  MF_STATEMENT: "Mutual fund statement — cross-check holdings against the Investments tab.",
  TAX_RETURN: "Filed income tax return.",
  PROPERTY_PAPER: "Property ownership or registration document.",
  BUSINESS_DOCUMENT: "Business-related document.",
  RECEIPT: "Purchase or payment receipt.",
  BILL: "Utility or service bill.",
  OTHER: "Uncategorized document.",
};

@Injectable()
export class MockOcrAdapter implements OcrAdapter {
  private readonly logger = new Logger("MockOcrAdapter");

  async process(fileBuffer: Buffer, mimeType: string, category: string): Promise<OcrResult> {
    // Real OCR/vision extraction is not wired up yet — this returns a deterministic,
    // category-aware placeholder so the rest of the pipeline (status transitions,
    // summary field, expiry-aware alerts) is genuinely exercised end to end rather
    // than left as a TODO. Swap the body of this method for a real adapter call later.
    this.logger.log(`[DEV ONLY] Mock OCR run on a ${mimeType} file (${fileBuffer.length} bytes), category=${category}`);
    const summary = CATEGORY_SUMMARIES[category] ?? CATEGORY_SUMMARIES.OTHER;
    return {
      text: `[Mock OCR] Text extraction is not yet implemented. This document was categorized as ${category}.`,
      summary,
    };
  }
}
