import { Injectable } from "@nestjs/common";

export interface OcrQualityInput {
  /** Tesseract's own reported confidence, already normalized 0-1 (see
   * StatementOcrAdapter#process). */
  engineConfidence: number;
  /** Total non-empty lines in the raw OCR'd text. */
  totalLines: number;
  /** How many of those lines the deterministic statement parser (statement-parser.ts)
   * could confidently extract a date+amount from — the strongest real-world signal of
   * "did OCR actually produce usable statement text," independent of what Tesseract
   * itself thinks of its own output. */
  deterministicallyParsedLines: number;
}

export interface OcrQualityResult {
  /** Final 0-1 extraction-confidence score surfaced on IngestionBatch. */
  extractionConfidence: number;
  /** Human-readable explanation, same "state every input that fed the score" spirit
   * as SuggestionScoringService.rationale. */
  rationale: string;
}

// Extraction confidence deliberately blends TWO independent signals rather than
// trusting Tesseract's self-reported score alone:
//   1. engineConfidence — the OCR engine's own per-recognition confidence. Useful, but
//      an engine can be "confident" about a garbled recognition of a genuinely blurry
//      photo just as easily as a good one — it does not know what a bank statement
//      line is SUPPOSED to look like.
//   2. parseSuccessRate — the fraction of OCR'd lines the deterministic parser could
//      actually turn into a real date+amount. This is the same "did this text actually
//      contain the shape of a statement line" ground truth the whole rest of the
//      pipeline already relies on, applied here as a quality signal instead of just a
//      parsing outcome. A page that OCR'd with high per-character confidence but
//      produced zero parseable transaction lines (e.g. a photo of the wrong document)
//      should score LOW here even though engineConfidence alone would say otherwise.
// The blend is a simple weighted average, not a model — this is a heuristic, honestly
// labeled as one; it exists to warn the user their photo may need retaking
// (OCR_LOW_CONFIDENCE_WARNING_THRESHOLD), never to silently drop or fabricate content.
const ENGINE_CONFIDENCE_WEIGHT = 0.4;
const PARSE_SUCCESS_WEIGHT = 0.6;

@Injectable()
export class OcrQualityEstimationService {
  estimate(input: OcrQualityInput): OcrQualityResult {
    if (input.totalLines === 0) {
      return { extractionConfidence: 0, rationale: "No text lines were recognized in the image at all." };
    }

    const parseSuccessRate = input.deterministicallyParsedLines / input.totalLines;
    const extractionConfidence =
      ENGINE_CONFIDENCE_WEIGHT * input.engineConfidence + PARSE_SUCCESS_WEIGHT * parseSuccessRate;

    const rationale =
      `OCR engine confidence ${Math.round(input.engineConfidence * 100)}%; ` +
      `${input.deterministicallyParsedLines}/${input.totalLines} recognized lines (${Math.round(parseSuccessRate * 100)}%) ` +
      `parsed as valid statement transactions.`;

    return { extractionConfidence: Math.max(0, Math.min(1, extractionConfidence)), rationale };
  }
}
