/**
 * Removes page furniture (letterhead, registered-office footer, "electronically generated document" notice,
 * UIN lines ...) that a PDF repeats on every page, before the text is chunked and embedded.
 *
 * Why: a 9-page insurance PDF carries ~100 words of identical footer on each page. With ~180-word chunks that
 * is more than half of every chunk, so every chunk of the policy "looks alike" to the embedding model (low
 * semantic scores) and the keyword scorer matches footer words instead of the clause being asked about.
 *
 * Safety rules:
 *  - Only text that has `--- Page N ---` markers (see TesseractOcrAdapter) is touched; anything else is returned as is.
 *  - A line is boilerplate only if it repeats, after normalisation, on at least 3 pages AND on at least half of them.
 *  - Short lines (< 3 words) are never removed: table cells such as "NA" or "Covered" are real content.
 *  - The FIRST occurrence is kept, so a repeated table header or the company name still appears once.
 */
const PAGE_MARKER = /^--- Page (\d+) ---$/;
const MIN_PAGES_REPEATED = 3;
const MIN_WORDS_PER_LINE = 3;

function normaliseLine(line: string): string {
  return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function wordCount(line: string): number {
  return line.split(/\s+/).filter(Boolean).length;
}

export function stripRepeatedPageBoilerplate(text: string): string {
  const lines = text.split(/\r?\n/);

  // Which page each line belongs to (0 = before the first marker).
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

  const threshold = Math.max(MIN_PAGES_REPEATED, Math.ceil(pageCount / 2));
  const boilerplate = new Set<string>();
  for (const [key, pages] of pagesSeenOn) if (pages.size >= threshold) boilerplate.add(key);
  if (boilerplate.size === 0) return text;

  const keptOnce = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const key = trimmed && !PAGE_MARKER.test(trimmed) ? normaliseLine(trimmed) : "";
    if (key && boilerplate.has(key)) {
      if (keptOnce.has(key)) continue;
      keptOnce.add(key);
    }
    out.push(line);
  }
  return out.join("\n");
}
