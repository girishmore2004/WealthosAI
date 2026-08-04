import { Injectable } from "@nestjs/common";

export interface ChunkerOptions {
  /** Target *child* chunk size, in words (a cheap, tokenizer-independent proxy — see
   * TokenBudgetService's doc comment for why this repo doesn't pull in a real
   * tokenizer just for a size heuristic). This is the size actually embedded and
   * matched against the query — small and precise on purpose. Default tuned so a
   * chunk comfortably fits inside the embedding model's input window with room to
   * spare. */
  targetWords?: number;
  /** How many words of the previous child chunk to repeat at the start of the next
   * one, so a fact split across a chunk boundary isn't invisible to both chunks. */
  overlapWords?: number;
  /** Target *parent* section size, in words — a coarser grouping of consecutive
   * paragraphs that each child chunk in the section is nested under. The parent's
   * text is never itself embedded or matched (that stays the child's job); it's
   * carried alongside every child purely so a matched child chunk can be handed to
   * synthesis/grounding with its surrounding context intact ("contextual chunk
   * expansion" / "parent-child hierarchical retrieval") instead of the narrow ~180-
   * word window that won the similarity search in isolation. Must be >= targetWords;
   * silently coerced up to targetWords if a caller passes something smaller. */
  parentTargetWords?: number;
}

export interface TextChunk {
  index: number;
  text: string;
  /** The larger section this chunk was extracted from, capped at MAX_PARENT_CHARS.
   * Always non-empty when `text` is non-empty (falls back to `text` itself for a
   * document too short to have a meaningfully larger parent). */
  parentText: string;
}

const DEFAULT_TARGET_WORDS = 180;
const DEFAULT_OVERLAP_WORDS = 30;
const DEFAULT_PARENT_TARGET_WORDS = 600;
// Bounds how much parent context synthesis/grounding pays token cost for per citation
// — generous enough to give real surrounding context, capped so one huge parent
// section (e.g. an entire long OCR'd document) can't single-handedly blow the
// gateway's MAX_CONTEXT_TOKENS budget on its own.
const MAX_PARENT_CHARS = 3000;

// Two-level splitter: paragraphs are first grouped into coarser "parent" sections
// (~600 words), then each parent section is split into the smaller "child" chunks
// that actually get embedded and searched (~180 words, same algorithm this class
// always used). Every child remembers its parent's text. This is the standard
// "parent document retriever" pattern — small chunks win the precision of similarity
// search, but the answer-composing step gets to see the fuller passage they came
// from, not just the isolated window that happened to score highest.
//
// Within each level, the same "prefer paragraph boundaries, fall back to sentence
// boundaries, fall back to a hard word-count cut" logic applies as before — parent
// boundaries are always paragraph boundaries (a parent section is never mid-sentence),
// child boundaries may fall back to sentence-level splitting when a single paragraph
// is itself larger than the child target.
@Injectable()
export class ChunkerService {
  chunk(text: string, options: ChunkerOptions = {}): TextChunk[] {
    const targetWords = options.targetWords ?? DEFAULT_TARGET_WORDS;
    const overlapWords = options.overlapWords ?? DEFAULT_OVERLAP_WORDS;
    const parentTargetWords = Math.max(options.parentTargetWords ?? DEFAULT_PARENT_TARGET_WORDS, targetWords);

    const cleaned = text.trim();
    if (!cleaned) return [];

    const parentSections = groupParagraphsIntoParents(cleaned, parentTargetWords);
    const children: { text: string; parentText: string }[] = [];

    for (const parentText of parentSections) {
      const childTexts = splitSectionIntoChildren(parentText, targetWords, overlapWords);
      const truncatedParent = truncate(parentText, MAX_PARENT_CHARS);
      for (const childText of childTexts) {
        children.push({ text: childText, parentText: truncatedParent });
      }
    }

    return children
      .map((c, index) => ({ index, text: c.text.trim(), parentText: c.parentText.trim() || c.text.trim() }))
      .filter((c) => c.text.length > 0);
  }
}

function groupParagraphsIntoParents(text: string, parentTargetWords: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];

  const parents: string[] = [];
  let current: string[] = [];
  let currentWordCount = 0;

  for (const paragraph of paragraphs) {
    const paragraphWordCount = countWords(paragraph);

    if (currentWordCount > 0 && currentWordCount + paragraphWordCount > parentTargetWords) {
      parents.push(current.join("\n\n"));
      current = [paragraph];
      currentWordCount = paragraphWordCount;
    } else {
      current.push(paragraph);
      currentWordCount += paragraphWordCount;
    }
  }

  if (current.length > 0) parents.push(current.join("\n\n"));
  return parents;
}

function splitSectionIntoChildren(sectionText: string, targetWords: number, overlapWords: number): string[] {
  const units = splitIntoUnits(sectionText, targetWords);
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
    // sentence punctuation) — flush it alone rather than let it silently balloon past
    // the target with nothing else able to join it.
    if (unitWordCount >= targetWords && current.length === 1) {
      chunks.push(current.join(" "));
      current = [];
      currentWordCount = 0;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }

  return chunks;
}

function splitIntoUnits(text: string, targetWords: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const units: string[] = [];
  for (const paragraph of paragraphs) {
    // Only fall through to sentence-level splitting for paragraphs long enough that
    // treating the whole thing as one unit would risk a single oversized chunk —
    // short paragraphs stay intact rather than being fragmented into single sentences
    // for no benefit.
    if (countWords(paragraph) > targetWords) {
      // Matches a run of text ending in .!?  (a normal sentence) OR, as the final
      // alternative, a trailing run of text with NO terminal punctuation at all. The
      // trailing alternative matters: without it, any paragraph whose last sentence
      // doesn't end in ./!/? (very common in OCR'd bank/card statement text, or any
      // paragraph simply cut off mid-thought) had that entire trailing fragment
      // silently dropped by the previous regex — content that was chunked and
      // embedded would never actually include it, making it permanently
      // unsearchable even though it exists in the source document. Every character
      // of the input paragraph must end up in some unit.
      const sentences = paragraph.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [paragraph];
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

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "…";
}
