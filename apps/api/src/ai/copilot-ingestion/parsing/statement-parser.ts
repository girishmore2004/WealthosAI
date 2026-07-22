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
}

// Ordered by how common each format is in Indian bank/card statement exports.
// Deliberately explicit patterns rather than one clever do-everything regex — a
// pattern that matches wrong is worse than a line correctly falling through to
// unparsedLines.
const DATE_PATTERNS: { regex: RegExp; parse: (m: RegExpMatchArray) => Date }[] = [
  // 2026-01-15 or 2026/01/15
  { regex: /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/, parse: (m) => new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) },
  // 15-01-2026 or 15/01/2026 (day-month-year, the common Indian statement format)
  { regex: /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/, parse: (m) => new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) },
  // 15 Jan 2026 / 15-Jan-2026
  {
    regex: /\b(\d{1,2})[\s-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s-](\d{4})\b/i,
    parse: (m) => new Date(Number(m[3]), MONTH_ABBREV.indexOf(m[2].slice(0, 3).toLowerCase()), Number(m[1])),
  },
];

const MONTH_ABBREV = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Matches an amount with optional ₹/Rs prefix, thousands separators, decimals, and an
// optional trailing Dr/Cr (debit/credit) marker some statements append.
const AMOUNT_PATTERN = /(?:₹|Rs\.?\s?)?(-?[\d,]+\.\d{2})\s*(Dr|Cr)?\b/i;

export function parseStatementText(rawText: string): StatementParseResult {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const parsed: ParsedLine[] = [];
  const unparsedLines: string[] = [];

  for (const line of lines) {
    const dateMatch = matchDate(line);
    const amountMatch = line.match(AMOUNT_PATTERN);

    if (!dateMatch || !amountMatch) {
      unparsedLines.push(line);
      continue;
    }

    const rawAmount = parseFloat(amountMatch[1].replace(/,/g, ""));
    // A "Cr" (credit) marker means money coming IN — not an expense. This parser is
    // for expense/debit ingestion, so credits are treated as not-a-transaction-to-
    // import rather than mis-imported as a negative expense.
    if (amountMatch[2]?.toLowerCase() === "cr") {
      continue;
    }
    const amount = Math.abs(rawAmount);

    // Merchant description: whatever's left of the line once the matched date and
    // amount substrings are removed.
    const merchantRaw = line.replace(dateMatch.raw, "").replace(amountMatch[0], "").replace(/[,|]+/g, " ").trim();

    if (!merchantRaw || Number.isNaN(amount) || amount <= 0) {
      unparsedLines.push(line);
      continue;
    }

    parsed.push({ rawLine: line, date: dateMatch.date, amount, merchantRaw });
  }

  return { parsed, unparsedLines };
}

function matchDate(line: string): { date: Date; raw: string } | null {
  for (const { regex, parse } of DATE_PATTERNS) {
    const m = line.match(regex);
    if (m) {
      const date = parse(m);
      if (!Number.isNaN(date.getTime())) {
        return { date, raw: m[0] };
      }
    }
  }
  return null;
}
