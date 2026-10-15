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

    // Text from a PDF carries "--- Page N ---" markers. Chunking each page on its own keeps a page's table or
    // field list together (a policy schedule's premium, period and sum insured are on one page) instead of
    // letting a chunk straddle two pages, and every chunk is labelled with its page so the label is embedded,
    // searched and shown to the answer model ("[Page 2] ...").
    const pages = splitIntoPages(cleaned);
    if (pages.length > 0) {
      const all: TextChunk[] = [];
      for (const { label, body } of pages) {
        for (const c of this.chunkPlain(body, targetWords, overlapWords, parentTargetWords)) {
          const prefix = label ? `[${label}] ` : "";
          all.push({ index: all.length, text: prefix + c.text, parentText: prefix + c.parentText });
        }
      }
      return all;
    }

    return this.chunkPlain(cleaned, targetWords, overlapWords, parentTargetWords);
  }

  private chunkPlain(cleaned: string, targetWords: number, overlapWords: number, parentTargetWords: number): TextChunk[] {
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

const PAGE_MARKER_LINE = /^--- Page (\d+) ---$/;
const EMPTY_PAGE_NOTE = "(no text detected on this page)";

/** Splits text on "--- Page N ---" marker lines. Returns [] when the text has no marker (so callers use the
 * plain path). Text before the first marker (the stored summary) is returned with no label. Pages with no
 * text are dropped. */
function splitIntoPages(text: string): { label: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => PAGE_MARKER_LINE.test(l.trim()))) return [];

  const pages: { label: string; body: string[] }[] = [{ label: "", body: [] }];
  for (const line of lines) {
    const m = PAGE_MARKER_LINE.exec(line.trim());
    if (m) pages.push({ label: `Page ${m[1]}`, body: [] });
    else pages[pages.length - 1].body.push(line);
  }
  return pages
    .map((p) => ({ label: p.label, body: p.body.join("\n").trim() }))
    .filter((p) => p.body.length > 0 && p.body !== EMPTY_PAGE_NOTE);
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
      // A "sentence" can itself be far larger than a chunk: text read from a PDF's text layer is one
      // line per row with no blank lines, and lists / tables / headings have no terminal punctuation,
      // so a whole page can come back as ONE sentence. Embedded as one chunk, only its first ~256
      // word pieces count semantically, so the rest of a policy's benefit list was unsearchable.
      for (const s of sentences.map((x) => x.trim()).filter(Boolean)) units.push(...splitOversizedUnit(s, targetWords));
    } else {
      units.push(paragraph.trim());
    }
  }
  return units;
}

/** Cuts a unit larger than `targetWords` into pieces of at most that size: on line breaks first (a row,
 * heading or list item stays whole), and by a hard word-count cut only for a single line that is itself
 * too long. A unit already within the target is returned unchanged. */
function splitOversizedUnit(unit: string, targetWords: number): string[] {
  if (countWords(unit) <= targetWords) return [unit];

  const out: string[] = [];
  let current: string[] = [];
  let currentWords = 0;
  const flush = () => {
    if (current.length > 0) out.push(current.join("\n"));
    current = [];
    currentWords = 0;
  };

  for (const line of unit.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const lineWords = countWords(line);
    if (lineWords > targetWords) {
      flush();
      const words = line.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += targetWords) out.push(words.slice(i, i + targetWords).join(" "));
      continue;
    }
    if (currentWords > 0 && currentWords + lineWords > targetWords) flush();
    current.push(line);
    currentWords += lineWords;
  }
  flush();
  return out;
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
