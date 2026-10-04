// Pure extraction + comparison for insurance policy documents. No I/O, no model.
//
// OCR text is noisy and policy layouts vary, so this is deliberately conservative: it only
// returns a field when a clearly-labelled value is found, and the caller NEVER writes these
// values into authoritative data — differences become discrepancies for the user to review.

export interface ExtractedPolicyFacts {
  premiumAmount?: string; // rupees, "8500.00"
  coverageAmount?: string; // rupees
  renewalDate?: string; // ISO date "2026-12-01"
  policyNumberLast4?: string; // only the tail is ever kept
}

const AMOUNT = String.raw`(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)`;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const toMoney = (raw: string): string | null => {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
};

const isoDate = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt.toISOString().slice(0, 10) : null;
};

function parseDate(text: string): string | null {
  // Indian numeric order, DD/MM/YYYY (also - and .)
  const numeric = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (numeric) return isoDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  const named = text.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/);
  if (named && MONTHS[named[2].toLowerCase()]) return isoDate(Number(named[3]), MONTHS[named[2].toLowerCase()], Number(named[1]));
  return null;
}

export function extractPolicyFacts(text: string): ExtractedPolicyFacts {
  const out: ExtractedPolicyFacts = {};
  const flat = text.replace(/\s+/g, " ");

  const premium = flat.match(new RegExp(String.raw`(?:total\s+|annual\s+|modal\s+)?premium(?:\s+(?:amount|payable|paid))?\s*(?:\([^)]{0,30}\))?\s*[:\-]?\s*` + AMOUNT, "i"));
  if (premium) {
    const v = toMoney(premium[1]);
    if (v) out.premiumAmount = v;
  }

  const coverage = flat.match(new RegExp(String.raw`(?:sum\s+(?:assured|insured)|(?:total\s+)?cover(?:age)?(?:\s+amount)?)\s*[:\-]?\s*` + AMOUNT, "i"));
  if (coverage) {
    const v = toMoney(coverage[1]);
    if (v) out.coverageAmount = v;
  }

  const renewal = flat.match(/(?:renewal|next\s+premium|premium\s+due|due)\s*(?:date|on)?\s*[:\-]?\s*([^,;]{4,30})/i);
  if (renewal) {
    const d = parseDate(renewal[1]);
    if (d) out.renewalDate = d;
  }

  const num = flat.match(/policy\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/-]{5,})/i);
  if (num) out.policyNumberLast4 = num[1].replace(/[^A-Za-z0-9]/g, "").slice(-4);

  return out;
}

/** How many of the three comparable fields (premium, coverage, renewal) were found. */
export function extractionCoverage(f: ExtractedPolicyFacts): { found: string[]; ratio: number } {
  const found = (["premiumAmount", "coverageAmount", "renewalDate"] as const).filter((k) => f[k] !== undefined);
  return { found: [...found], ratio: found.length / 3 };
}

export interface PolicyRecord {
  premiumAmount: string;
  coverageAmount: string;
  renewalDate: Date;
}

export interface FieldDiscrepancy {
  field: "premiumAmount" | "coverageAmount" | "renewalDate";
  documentValue: string;
  databaseValue: string;
}

export interface ComparisonResult {
  discrepancies: FieldDiscrepancy[];
  // Fields where the document and database agree — used to auto-close earlier discrepancies.
  matching: Array<FieldDiscrepancy["field"]>;
}

/**
 * Compares extracted facts to the stored policy. Money differs when it is off by more than half
 * a rupee. Renewal compares the month and day only: a document from last term legitimately
 * shows an earlier YEAR, and flagging that every renewal would just be noise.
 */
export function comparePolicyFacts(doc: ExtractedPolicyFacts, db: PolicyRecord): ComparisonResult {
  const discrepancies: FieldDiscrepancy[] = [];
  const matching: ComparisonResult["matching"] = [];

  for (const field of ["premiumAmount", "coverageAmount"] as const) {
    const d = doc[field];
    if (d === undefined) continue;
    if (Math.abs(Number(d) - Number(db[field])) > 0.5) discrepancies.push({ field, documentValue: d, databaseValue: Number(db[field]).toFixed(2) });
    else matching.push(field);
  }

  if (doc.renewalDate !== undefined) {
    const dbIso = db.renewalDate.toISOString().slice(0, 10);
    if (doc.renewalDate.slice(5) !== dbIso.slice(5)) discrepancies.push({ field: "renewalDate", documentValue: doc.renewalDate, databaseValue: dbIso });
    else matching.push("renewalDate");
  }
  return { discrepancies, matching };
}
