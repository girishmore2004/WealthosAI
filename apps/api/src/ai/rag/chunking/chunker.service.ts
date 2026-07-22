import { Injectable } from "@nestjs/common";

export interface ChunkerOptions {
  /** Target chunk size, in words (a cheap, tokenizer-independent proxy — see
   * TokenBudgetService's doc comment for why this repo doesn't pull in a real
   * tokenizer just for a size heuristic). Default tuned so a chunk comfortably fits
   * inside the embedding model's input window with room to spare. */
  targetWords?: number;
  /** How many words of the previous chunk to repeat at the start of the next one, so
   * a fact split across a chunk boundary isn't invisible to both chunks. */
  overlapWords?: number;
}

export interface TextChunk {
  index: number;
  text: string;
}

const DEFAULT_TARGET_WORDS = 180;
const DEFAULT_OVERLAP_WORDS = 30;

// Metadata-aware in the sense the *caller* attaches source metadata per chunk (see
// RagIndexingService) — this class's own job is purely the text-splitting decision:
// prefer paragraph boundaries, fall back to sentence boundaries, fall back to a hard
// word-count cut only if a single paragraph/sentence is itself larger than the target
// (rare, but a single huge OCR paragraph shouldn't become one enormous unsplit chunk).
@Injectable()
export class ChunkerService {
  chunk(text: string, options: ChunkerOptions = {}): TextChunk[] {
    const targetWords = options.targetWords ?? DEFAULT_TARGET_WORDS;
    const overlapWords = options.overlapWords ?? DEFAULT_OVERLAP_WORDS;

    const cleaned = text.trim();
    if (!cleaned) return [];

    const units = splitIntoUnits(cleaned);
    const chunks: string[] = [];
    let current: string[] = [];
    let currentWordCount = 0;

    for (const unit of units) {
      const unitWordCount = countWords(unit);

      if (currentWordCount > 0 && currentWordCount + unitWordCount > targetWords) {
        chunks.push(current.join(" "));
        const overlapText = takeLastWords(current.join(" "), overlapWords);
        current = overlapText ? [overlapText, unit] : [unit];
        currentWordCount = countWords(current.join(" "));
      } else {
        current.push(unit);
        currentWordCount += unitWordCount;
      }

      // A single unit bigger than the whole target (e.g. one huge paragraph with no
      // sentence punctuation) — flush it alone rather than let it silently balloon
      // past the target with nothing else able to join it.
      if (unitWordCount >= targetWords && current.length === 1) {
        chunks.push(current.join(" "));
        current = [];
        currentWordCount = 0;
      }
    }

    if (current.length > 0) {
      chunks.push(current.join(" "));
    }

    return chunks.map((text, index) => ({ index, text: text.trim() })).filter((c) => c.text.length > 0);
  }
}

function splitIntoUnits(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const units: string[] = [];
  for (const paragraph of paragraphs) {
    // Only fall through to sentence-level splitting for paragraphs long enough that
    // treating the whole thing as one unit would risk a single oversized chunk —
    // short paragraphs stay intact rather than being fragmented into single sentences
    // for no benefit.
    if (countWords(paragraph) > DEFAULT_TARGET_WORDS) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [paragraph];
      units.push(...sentences.map((s) => s.trim()).filter(Boolean));
    } else {
      units.push(paragraph.trim());
    }
  }
  return units;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function takeLastWords(text: string, count: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(Math.max(0, words.length - count)).join(" ");
}
