export interface ParsedLine {
  rawLine: string;
  date: Date;
  amount: number;
  merchantRaw: string;
}

export interface StatementParseResult {
  parsed: ParsedLine[];
  /** Lines that didn't clearly contain both a date and an amount — handed to
   * `StatementUnderstandingService`'s AI fallback rather than silently dropped, and
   * still shown to the user if even that fails (see copilot-ingestion.service.ts). */
  unparsedLines: string[];
  /** Lines recognised and deliberately NOT imported as expenses: opening/closing balance and total
   * rows that carry a date and an amount (importing them would create phantom expenses), and
   * credit-only rows. Never sent to the AI fallback. */
  skippedLines?: string[];
}

const MONTH_ABBREV = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";

// Builds a Date only when the calendar components are real (31/02/2026 is rejected rather than silently
// rolling over into March) and the year is plausible for a bank statement.
function buildDate(year: number, monthIndex: number, day: number): Date | null {
  if (year < 100) year += 2000;
  if (year < 2000 || year > 2100) return null;
  const d = new Date(year, monthIndex, day);
  if (d.getFullYear() !== year || d.getMonth() !== monthIndex || d.getDate() !== day) return null;
  return d;
}

// Ordered by how common each format is in Indian bank/card statement exports.
// Deliberately explicit patterns rather than one clever do-everything regex — a
// pattern that matches wrong is worse than a line correctly falling through to
// unparsedLines.
const DATE_PATTERNS: { regex: RegExp; parse: (m: RegExpMatchArray) => Date | null }[] = [
  // 2026-01-15 or 2026/01/15
  { regex: /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/, parse: (m) => buildDate(Number(m[1]), Number(m[2]) - 1, Number(m[3])) },
  // 15-01-2026, 15/01/2026 or 15.01.2026 (day-month-year, the common Indian statement format)
  { regex: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/, parse: (m) => buildDate(Number(m[3]), Number(m[2]) - 1, Number(m[1])) },
  // 15 Jan 2026 / 15-Jan-2026 / 15/Jan/2026 / 15 January 2026
  {
    regex: new RegExp(`\\b(\\d{1,2})[\\s/-]${MONTH_RE}[\\s/,-]+(\\d{4})\\b`, "i"),
    parse: (m) => buildDate(Number(m[3]), MONTH_ABBREV.indexOf(m[2].slice(0, 3).toLowerCase()), Number(m[1])),
  },
  // Jan 15, 2026 / January 15 2026
  {
    regex: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"),
    parse: (m) => buildDate(Number(m[3]), MONTH_ABBREV.indexOf(m[1].slice(0, 3).toLowerCase()), Number(m[2])),
  },
  // 15 Jan 26 / 15-Jan-26 (two-digit year)
  {
    regex: new RegExp(`\\b(\\d{1,2})[\\s/-]${MONTH_RE}[\\s/-](\\d{2})\\b`, "i"),
    parse: (m) => buildDate(Number(m[3]), MONTH_ABBREV.indexOf(m[2].slice(0, 3).toLowerCase()), Number(m[1])),
  },
  // 15/01/26 or 15-01-26 (two-digit year, tried last so a four-digit year always wins)
  { regex: /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2})\b(?!\d)/, parse: (m) => buildDate(Number(m[3]), Number(m[2]) - 1, Number(m[1])) },
];

// An amount: optional ₹/Rs/INR prefix, then either grouped thousands (1,24,900 / 12,345.50), or a plain
// number with decimals, or a plain integer that carries a currency marker. Optional Dr/Cr suffix.
// Plain integers WITHOUT a marker are never amounts (they are reference numbers: "4829102").
const AMOUNT_GLOBAL =
  /(?:(₹|Rs\.?\s?|INR\s?)(-?\d[\d,]*(?:\.\d{1,2})?)|(-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|-?\d+\.\d{1,2}))\s*(Dr|Cr)?\b/gi;

// Rows that describe the statement, not a transaction, even though they contain a date and a number.
const NON_TRANSACTION_ROW =
  /\b(opening|closing|available|ledger|running)\s+balance\b|\bbalance\s+(b\/?f|c\/?f|brought forward|carried forward)\b|\b(brought|carried)\s+forward\b|\btotal\s+(debits?|credits?|withdrawals?|deposits?)\b|\bstatement\s+(period|date|summary)\b|\bgrand total\b/i;
// Page markers inserted by the PDF/OCR step and empty-page notes: not statement content at all.
const PAGE_MARKER = /^-{2,}\s*page\s+\d+\s*-{2,}$|^\(no text detected[^)]*\)$/i;

interface FoundAmount {
  value: number;
  marker: "dr" | "cr" | null;
  raw: string;
}

function findAmounts(text: string): FoundAmount[] {
  const found: FoundAmount[] = [];
  for (const m of text.matchAll(AMOUNT_GLOBAL)) {
    const numeric = (m[2] ?? m[3] ?? "").replace(/,/g, "");
    const value = parseFloat(numeric);
    if (Number.isNaN(value)) continue;
    found.push({ value, marker: m[4] ? (m[4].toLowerCase() as "dr" | "cr") : null, raw: m[0] });
  }
  return found;
}

export function parseStatementText(rawText: string): StatementParseResult {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !PAGE_MARKER.test(l));

  const parsed: ParsedLine[] = [];
  const unparsedLines: string[] = [];
  const skippedLines: string[] = [];

  for (const line of lines) {
    const dateMatch = matchDate(line);
    // Amounts are searched with the date removed, so "15.01.2026" is never read as a decimal amount.
    const withoutDate = dateMatch ? line.replace(dateMatch.raw, " ") : line;
    const amounts = findAmounts(withoutDate);

    if (!dateMatch || amounts.length === 0) {
      unparsedLines.push(line);
      continue;
    }

    // Balance / total rows have a date and a number but are not spending.
    if (NON_TRANSACTION_ROW.test(line)) {
      skippedLines.push(line);
      continue;
    }

    // Pick the transaction amount. Statements often end a row with the running balance, so with several
    // amounts and no Dr/Cr marker the LAST one is the balance and the first is the transaction. An
    // explicit Dr marker always wins; a row whose only marker is Cr is a credit.
    const debit = amounts.find((a) => a.marker === "dr");
    const credit = amounts.find((a) => a.marker === "cr");
    let chosen: FoundAmount | undefined = debit;
    if (!chosen && credit) {
      // A "Cr" (credit) marker means money coming IN — not an expense. This parser is for
      // expense/debit ingestion, so credits are treated as not-a-transaction-to-import rather
      // than mis-imported as a negative expense. Exception: some banks suffix the RUNNING BALANCE
      // with Cr ("450.00  12,000.00 Cr"); a Cr-marked amount that comes last, after an unmarked
      // amount, is that balance and the earlier amount is the transaction.
      const creditIsTrailingBalance = amounts[amounts.length - 1] === credit && amounts.some((a) => a.marker === null);
      if (!creditIsTrailingBalance) {
        skippedLines.push(line);
        continue;
      }
    }
    if (!chosen) {
      const unmarked = amounts.filter((a) => a.marker === null);
      chosen = unmarked[0] ?? amounts[0];
    }

    const amount = Math.abs(chosen.value);

    // Merchant description: whatever's left of the line once the matched date and every amount
    // substring (transaction amount and any balance column) are removed.
    let merchantRaw = withoutDate;
    for (const a of amounts) merchantRaw = merchantRaw.replace(a.raw, " ");
    merchantRaw = merchantRaw.replace(/[,|]+/g, " ").replace(/\s{2,}/g, " ").trim();

    if (!merchantRaw || Number.isNaN(amount) || amount <= 0) {
      unparsedLines.push(line);
      continue;
    }

    parsed.push({ rawLine: line, date: dateMatch.date, amount, merchantRaw });
  }

  return { parsed, unparsedLines, skippedLines };
}

function matchDate(line: string): { date: Date; raw: string } | null {
  for (const { regex, parse } of DATE_PATTERNS) {
    const m = line.match(regex);
    if (m) {
      const date = parse(m);
      if (date && !Number.isNaN(date.getTime())) {
        return { date, raw: m[0] };
      }
    }
  }
  return null;
}
