/**
 * Removes page furniture (letterhead, registered-office footer, "electronically generated document" notice,
 * stamp / print-order lines, "Page 3 of 9") that a PDF repeats on every page, before the text is chunked
 * and embedded.
 *
 * Why it matters:
 *  - A 9-page insurance PDF carries ~100 words of identical footer on each page. With ~180-word chunks that is
 *    more than half of every chunk, so all chunks look alike to the embedding model and the keyword scorer
 *    matches footer words instead of the content being asked about.
 *  - Footers also contain figures and dates that are NOT the document's own (print-order validity periods,
 *    stamp numbers). Left in, the answer model can report them as the policy period or an amount.
 *
 * Rules (all generic, nothing specific to one issuer):
 *  - Only text with `--- Page N ---` markers (written by TesseractOcrAdapter) is touched; anything else is returned as is.
 *  - A line counts as repeated when its normalised form (lower-case, digits collapsed) appears on at least
 *    3 pages and on at least half of them. A line that contains digits must appear on at least 70% of pages,
 *    so a real recurring row (a monthly debit in a bank statement) is never mistaken for a footer.
 *  - Lines of fewer than 3 words are never removed: table cells such as "NA" or "Covered" are real content.
 *  - A repeated line that is short and has no digits (a column header such as "Date Narration Withdrawal Balance")
 *    keeps its FIRST occurrence. Every other repeated line (long notices, anything with numbers) is removed everywhere.
 */
const PAGE_MARKER = /^--- Page (\d+) ---$/;
const MIN_PAGES_REPEATED = 3;
const MIN_WORDS_PER_LINE = 3;
const MAX_WORDS_FOR_KEEP_FIRST = 8;
const DIGIT_LINE_MIN_PAGE_SHARE = 0.7;

function normaliseLine(line: string): string {
  return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function wordCount(line: string): number {
  return line.split(/\s+/).filter(Boolean).length;
}

export function stripRepeatedPageBoilerplate(text: string): string {
  const lines = text.split(/\r?\n/);

  // Which page each line belongs to (0 = before the first marker, e.g. the stored summary).
  const pageOfLine: number[] = [];
  let page = 0;
  let pageCount = 0;
  for (const line of lines) {
    if (PAGE_MARKER.test(line.trim())) {
      page += 1;
      pageCount = page;
    }
    pageOfLine.push(page);
  }
  if (pageCount < MIN_PAGES_REPEATED) return text;

  const pagesSeenOn = new Map<string, Set<number>>();
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || PAGE_MARKER.test(trimmed) || wordCount(trimmed) < MIN_WORDS_PER_LINE) return;
    const key = normaliseLine(trimmed);
    let pages = pagesSeenOn.get(key);
    if (!pages) pagesSeenOn.set(key, (pages = new Set()));
    pages.add(pageOfLine[i]);
  });

  const plainThreshold = Math.max(MIN_PAGES_REPEATED, Math.ceil(pageCount / 2));
  const digitThreshold = Math.max(MIN_PAGES_REPEATED, Math.ceil(pageCount * DIGIT_LINE_MIN_PAGE_SHARE));
  const keepFirst = new Set<string>();
  const dropAll = new Set<string>();
  for (const [key, pages] of pagesSeenOn) {
    // normaliseLine collapses every number to "#", so "#" in the key means the original line had digits.
    const hasDigits = key.includes("#");
    if (pages.size < (hasDigits ? digitThreshold : plainThreshold)) continue;
    if (!hasDigits && wordCount(key) <= MAX_WORDS_FOR_KEEP_FIRST) keepFirst.add(key);
    else dropAll.add(key);
  }
  if (keepFirst.size === 0 && dropAll.size === 0) return text;

  const keptOnce = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const key = trimmed && !PAGE_MARKER.test(trimmed) ? normaliseLine(trimmed) : "";
    if (key && dropAll.has(key)) continue;
    if (key && keepFirst.has(key)) {
      if (keptOnce.has(key)) continue;
      keptOnce.add(key);
    }
    out.push(line);
  }
  return out.join("\n");
}
