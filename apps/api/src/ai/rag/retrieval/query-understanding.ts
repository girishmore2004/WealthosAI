import { AiSourceType } from "@wealthos/db";
import { tokenize } from "./keyword-scorer.service";
import { QueryComplexity, QueryType } from "../rag.constants";

// Deterministic query understanding for AI Search. Pure functions, no I/O, no model call:
// it runs on every search (including when the model-based rewrite is unavailable), so it
// can never fail or add latency. It only ever EXTRACTS what the user literally wrote.
// It never inserts a date, amount, category or entity that is not in the question, and it
// never rewrites the question — the original text is what retrieval and synthesis see.

export type SearchIntent =
  | "portfolio"
  | "holdings"
  | "transactions"
  | "expenses"
  | "income"
  | "cash_flow"
  | "investments"
  | "sips"
  | "goals"
  | "loans"
  | "insurance"
  | "documents"
  | "general";

export type LookupKind = "exact" | "analytical";

export interface ExtractedDateRange {
  /** Inclusive start, YYYY-MM-DD (UTC). */
  from: string;
  /** Inclusive end, YYYY-MM-DD (UTC). */
  to: string;
  /** The phrase from the question this range was read from. */
  matchedText: string;
}

export interface ExtractedAmountFilter {
  min?: number;
  max?: number;
  exact?: number;
  matchedText: string;
}

export interface QueryUnderstanding {
  intent: SearchIntent;
  lookupKind: LookupKind;
  /** Present only when the question itself names a date or period. */
  dateRange?: ExtractedDateRange;
  /** Present only when the question itself names an amount (with a currency/unit or a comparison cue). */
  amount?: ExtractedAmountFilter;
  /** Things the question explicitly excludes ("excluding rent", "without insurance"). */
  negations: string[];
  /** Specific document kinds named in the question (e.g. "loan agreement"). */
  documentTypeHints: string[];
  /** True when the question has no searchable subject (e.g. "what about it?"). */
  needsClarification: boolean;
  clarificationReason?: string;
  /** Source types the user NAMED ("my alerts", "the monthly report", "my loan agreement"). Used as a soft
   * ranking boost, never a filter. */
  explicitSourceTypes: AiSourceType[];
  /** Which indexed source types are the natural home for this intent. Informational: used for
   * explanations and ranking hints, never as a hard filter (a hard filter could hide valid evidence). */
  preferredSourceTypes: AiSourceType[];
}

const INTENT_KEYWORDS: Array<{ intent: Exclude<SearchIntent, "general">; words: string[]; weight?: number }> = [
  { intent: "documents", weight: 2, words: ["document", "documents", "agreement", "clause", "uploaded", "upload", "pdf", "contract", "statement", "says", "say", "mention", "mentioned", "terms", "letter", "certificate", "receipt"] },
  { intent: "sips", words: ["sip", "sips", "systematic"] },
  { intent: "loans", words: ["loan", "loans", "emi", "emis", "mortgage", "borrow", "borrowed", "lender", "outstanding", "prepay", "prepayment", "tenure", "debt"] },
  { intent: "insurance", words: ["insurance", "insured", "policy", "policies", "premium", "premiums", "nominee", "coverage", "cover", "claim", "renewal"] },
  { intent: "investments", words: ["invest", "invested", "investment", "investments", "mutual", "index fund", "index funds", "stock", "stocks", "equity", "ppf", "nps", "epf", "fd", "gold", "etf", "nav", "returns", "return"] },
  { intent: "holdings", words: ["holding", "holdings", "allocation", "allocated", "units"] },
  { intent: "portfolio", words: ["portfolio", "networth", "net worth", "assets", "asset", "liabilities", "wealth"] },
  { intent: "goals", words: ["goal", "goals", "target", "milestone", "on track"] },
  { intent: "income", words: ["income", "salary", "earn", "earned", "earning", "paycheck", "received", "bonus"] },
  { intent: "cash_flow", words: ["cashflow", "cash flow", "savings rate", "surplus", "saved", "saving", "savings", "emergency fund", "net cashflow"] },
  { intent: "expenses", words: ["expense", "expenses", "spend", "spent", "spending", "cost", "bill", "bills", "category", "categories"] },
  { intent: "transactions", words: ["transaction", "transactions", "merchant", "paid", "payment", "payments", "purchase", "purchases", "transfer"] },
];

const FACT_TYPES: AiSourceType[] = ["FINANCIAL_FACT", "REPORT", "SNAPSHOT"];

const PREFERRED_SOURCES: Record<SearchIntent, AiSourceType[]> = {
  portfolio: FACT_TYPES,
  holdings: FACT_TYPES,
  transactions: FACT_TYPES,
  expenses: FACT_TYPES,
  income: FACT_TYPES,
  cash_flow: FACT_TYPES,
  investments: FACT_TYPES,
  sips: FACT_TYPES,
  goals: FACT_TYPES,
  loans: ["FINANCIAL_FACT", "DOCUMENT"],
  insurance: ["FINANCIAL_FACT", "DOCUMENT"],
  documents: ["DOCUMENT"],
  general: [],
};

const DOCUMENT_TYPE_PATTERNS: Array<[RegExp, string]> = [
  [/\bloan agreement\b/i, "loan agreement"],
  [/\binsurance (?:policy|document)\b/i, "insurance policy"],
  [/\bbank statement\b/i, "bank statement"],
  [/\bsalary slip\b|\bpayslip\b/i, "salary slip"],
  [/\btax (?:return|document|certificate)\b|\bform ?16\b|\bitr\b/i, "tax document"],
  [/\bsale deed\b|\brent agreement\b|\blease\b/i, "property document"],
  [/\bcredit card statement\b/i, "credit card statement"],
];

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

// Words that carry no searchable subject on their own. A question made only of these (plus
// pronouns that point at an earlier turn) cannot be searched meaningfully.
const CONTENTLESS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "of", "to", "in", "on", "at", "by", "for", "with", "from", "as",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "have", "has", "had", "it", "its", "this", "that",
  "these", "those", "me", "my", "mine", "we", "our", "you", "your", "about", "tell", "show", "give", "get", "let", "what",
  "which", "who", "whom", "how", "much", "many", "when", "where", "why", "can", "could", "should", "would", "will", "please",
  "any", "all", "some", "there", "here", "so", "than", "also", "just", "into", "up", "out", "need", "want", "know", "same",
  "one", "ones", "other", "another", "more", "again", "them", "they", "their", "last", "next", "before", "after", "now",
  "tell", "said", "earlier", "previous", "previously", "above", "ok", "okay", "yes", "no", "thanks", "thank",
  "day", "days", "week", "weeks", "month", "months", "year", "years", "time", "period", "today", "ago",
]);

const ANALYTICAL_CUES =
  /\b(compare|compared|comparison|trend|trends|changed?|changes|how (?:has|have|am|is|are|much more|much less)|on track|why|should|improve|average|growth|vs\.?|versus|over time|analy[sz]e|analysis|breakdown|ratio|forecast|project(?:ed|ion)?|what if|recommend|best|worst|biggest|highest|lowest)\b/i;

const EXACT_CUES = /^\s*(?:what|when|which|who|where|list|show|how much|how many|give me|tell me|did|do|does|is|are|was|were|have|has|can)\b/i;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthBounds(year: number, month: number): { from: string; to: string } {
  return { from: iso(new Date(Date.UTC(year, month, 1))), to: iso(new Date(Date.UTC(year, month + 1, 0))) };
}

const MONTH_NAME_YEAR = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?,?\s+(?:of\s+)?(\d{4})\b/gi;
const ISO_MONTH = /\b(\d{4})-(\d{2})\b(?!-\d)/g;

function distinctNamedMonths(text: string): Set<string> {
  const months = new Set<string>();
  for (const m of text.matchAll(MONTH_NAME_YEAR)) months.add(`${m[2]}-${String(MONTHS[m[1]] + 1).padStart(2, "0")}`);
  for (const m of text.matchAll(ISO_MONTH)) if (Number(m[2]) >= 1 && Number(m[2]) <= 12) months.add(`${m[1]}-${m[2]}`);
  return months;
}

/** Reads an explicit date/period from the question. Returns undefined when the question names none —
 * a missing period is never filled in. `now` only resolves relative phrases ("last month"). */
export function extractDateRange(query: string, now: Date = new Date()): ExtractedDateRange | undefined {
  const text = query.toLowerCase();
  // Two different named periods ("compare September 2026 with August 2026") are a comparison, not one
  // period: reporting only the first would misstate the question, so no single range is returned.
  if (distinctNamedMonths(text).size > 1) return undefined;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  let match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (match) {
    const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (!Number.isNaN(d.getTime()) && d.getUTCMonth() === Number(match[2]) - 1) {
      return { from: iso(d), to: iso(d), matchedText: match[0] };
    }
  }

  match = /\b(?:(\d{4})-(\d{2}))\b(?!-)/.exec(text);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) {
    const b = monthBounds(Number(match[1]), Number(match[2]) - 1);
    return { ...b, matchedText: match[0] };
  }

  match = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?,?\s+(?:of\s+)?(\d{4})\b/.exec(text);
  if (match) {
    const b = monthBounds(Number(match[2]), MONTHS[match[1]]);
    return { ...b, matchedText: match[0] };
  }

  match = /\b(this|current) month\b/.exec(text);
  if (match) return { ...monthBounds(y, m), matchedText: match[0] };

  match = /\blast month\b/.exec(text);
  if (match) {
    const d = new Date(Date.UTC(y, m - 1, 1));
    return { ...monthBounds(d.getUTCFullYear(), d.getUTCMonth()), matchedText: match[0] };
  }

  match = /\b(this|current) year\b/.exec(text);
  if (match) return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(new Date(Date.UTC(y, 11, 31))), matchedText: match[0] };

  match = /\blast year\b/.exec(text);
  if (match) return { from: iso(new Date(Date.UTC(y - 1, 0, 1))), to: iso(new Date(Date.UTC(y - 1, 11, 31))), matchedText: match[0] };

  match = /\blast (\d{1,3}) (day|days|week|weeks|month|months)\b/.exec(text);
  if (match) {
    const n = Number(match[1]);
    const unit = match[2].startsWith("day") ? 1 : match[2].startsWith("week") ? 7 : 30;
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = new Date(to.getTime() - n * unit * 86_400_000);
    return { from: iso(from), to: iso(to), matchedText: match[0] };
  }

  match = /\b(?:in|during|for|of|year)\s+((?:19|20)\d{2})\b(?!\s*(?:rupees|rs|inr))/.exec(text);
  if (match) {
    const year = Number(match[1]);
    return { from: iso(new Date(Date.UTC(year, 0, 1))), to: iso(new Date(Date.UTC(year, 11, 31))), matchedText: match[0] };
  }

  return undefined;
}

const AMOUNT_TOKEN = "(?:₹|rs\\.?|inr)?\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(lakhs?|lacs?|crores?|cr|k|thousand)?";

function toNumber(raw: string, unit?: string): number | undefined {
  const base = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(base)) return undefined;
  const u = (unit ?? "").toLowerCase();
  if (u.startsWith("lakh") || u.startsWith("lac")) return base * 100_000;
  if (u.startsWith("crore") || u === "cr") return base * 10_000_000;
  if (u === "k" || u === "thousand") return base * 1_000;
  return base;
}

/** Reads an amount constraint the question states. A bare number with no currency, unit or
 * comparison cue is NOT treated as an amount (it may be a year, a count or an id). */
export function extractAmountFilter(query: string): ExtractedAmountFilter | undefined {
  const text = query.toLowerCase();

  let match = new RegExp(`\\bbetween\\s+${AMOUNT_TOKEN}\\s+(?:and|to)\\s+${AMOUNT_TOKEN}`).exec(text);
  if (match) {
    const a = toNumber(match[1], match[2]);
    const b = toNumber(match[3], match[4]);
    if (a !== undefined && b !== undefined) return { min: Math.min(a, b), max: Math.max(a, b), matchedText: match[0].trim() };
  }

  match = new RegExp(`\\b(?:above|over|more than|greater than|at least|exceeding|exceeds|higher than|minimum)\\s+${AMOUNT_TOKEN}`).exec(text);
  if (match) {
    const v = toNumber(match[1], match[2]);
    if (v !== undefined) return { min: v, matchedText: match[0].trim() };
  }

  match = new RegExp(`\\b(?:below|under|less than|lower than|at most|up to|not more than|maximum)\\s+${AMOUNT_TOKEN}`).exec(text);
  if (match) {
    const v = toNumber(match[1], match[2]);
    if (v !== undefined) return { max: v, matchedText: match[0].trim() };
  }

  match = new RegExp(`(?:₹|\\brs\\.?\\s?|\\binr\\s?)\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(lakhs?|lacs?|crores?|cr|k|thousand)?`).exec(text);
  if (match) {
    const v = toNumber(match[1], match[2]);
    if (v !== undefined) return { exact: v, matchedText: match[0].trim() };
  }

  match = /\b(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr|k)\b/.exec(text);
  if (match) {
    const v = toNumber(match[1], match[2]);
    if (v !== undefined) return { exact: v, matchedText: match[0].trim() };
  }

  return undefined;
}

/** Terms the question explicitly excludes. They are reported, never silently dropped or applied. */
export function extractNegations(query: string): string[] {
  const out: string[] = [];
  const pattern = /\b(?:excluding|exclude|except|without|other than|besides|not including|ignoring)\s+([a-z][a-z ,&'-]{1,60}?)(?=[.?;]|\s+(?:in|for|from|during|over|since|show|list|and show)\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(query)) !== null) {
    // "excluding rent and dining" excludes both terms.
    for (const part of m[1].split(/\s*,\s*|\s+and\s+|\s+or\s+/i)) {
      const term = part.trim().toLowerCase();
      if (term && !out.includes(term)) out.push(term);
    }
  }
  return out;
}

const EXPLICIT_SOURCE_PATTERNS: Array<[RegExp, AiSourceType]> = [
  [/\balerts?\b|\bnotifications?\b/i, "ALERT"],
  [/\b(?:monthly |annual )?reports?\b/i, "REPORT"],
  [/\bsnapshot\b/i, "SNAPSHOT"],
  [/\bcoach\b|\byou (?:told|said|suggested|advised)\b|\b(?:earlier|previous) advice\b/i, "COACH_INTERACTION"],
  [/\bdocuments?\b|\bpdf\b|\buploaded\b|\bagreement\b|\bclause\b|\bcontract\b/i, "DOCUMENT"],
];

export function extractExplicitSourceTypes(query: string): AiSourceType[] {
  return EXPLICIT_SOURCE_PATTERNS.filter(([re]) => re.test(query)).map(([, type]) => type);
}

const NEGATION_CLAUSE = /\b(?:excluding|exclude|except|without|other than|besides|not including|ignoring)\s+[a-z][a-z ,&'-]{1,60}?(?=[.?;]|\s+(?:in|for|from|during|over|since|show|list|and show)\b|$)/gi;
const COMPARISON_WORDS = /\b(?:compare|compared|comparison|versus|vs\.?)\b/gi;
const SOURCE_WORDS = /\b(?:alerts?|notifications?|snapshot|(?:monthly |annual )?reports?)\b/gi;

/** An extra retrieval phrasing that keeps only what the question is ABOUT: month names become the ISO
 * month the index stores (September 2026 -> 2026-09), and words that describe the request rather than the
 * records (the amount comparison, the exclusion clause, "compare", "alerts") are removed so they cannot
 * fail the lexical evidence bar. It only removes or reformats the user's own words — it adds nothing —
 * and the original question is still searched too. Returns undefined when nothing would change. */
export function normalizeForRetrieval(query: string): string | undefined {
  let out = query;
  out = out.replace(MONTH_NAME_YEAR, (_m, name: string, year: string) => `${year}-${String(MONTHS[name.toLowerCase()] + 1).padStart(2, "0")}`);
  const amount = extractAmountFilter(out);
  if (amount) out = out.replace(new RegExp(amount.matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  out = out.replace(NEGATION_CLAUSE, " ").replace(COMPARISON_WORDS, " ").replace(SOURCE_WORDS, " ");
  out = out.replace(/\s+/g, " ").replace(/\s+([?.!,])/g, "$1").trim();
  if (!out || out.toLowerCase() === query.trim().toLowerCase()) return undefined;
  if (hasNoSearchableSubject(out)) return undefined;
  return out;
}

function classifyIntent(query: string): SearchIntent {
  const text = ` ${query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  let best: SearchIntent = "general";
  let bestScore = 0;
  for (const entry of INTENT_KEYWORDS) {
    let score = 0;
    for (const word of entry.words) {
      if (text.includes(` ${word} `)) score += (entry.weight ?? 1) * (word.includes(" ") ? 2 : 1);
    }
    if (score > bestScore) {
      best = entry.intent;
      bestScore = score;
    }
  }
  return best;
}

/** True when nothing in the question names a subject to search for. */
export function hasNoSearchableSubject(query: string): boolean {
  const tokens = tokenize(query).filter((t) => /[a-z]/.test(t));
  const subject = tokens.filter((t) => !CONTENTLESS.has(t));
  const hasNumber = /\d/.test(query);
  return subject.length === 0 && !hasNumber;
}

export function understandQuery(query: string, now: Date = new Date()): QueryUnderstanding {
  const trimmed = query.trim();
  const dateRange = extractDateRange(trimmed, now);
  const amount = extractAmountFilter(trimmed);
  const negations = extractNegations(trimmed);
  const intent = classifyIntent(trimmed);
  const documentTypeHints = DOCUMENT_TYPE_PATTERNS.filter(([re]) => re.test(trimmed)).map(([, label]) => label);

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const analytical = ANALYTICAL_CUES.test(trimmed);
  const exactSignals = Boolean(amount) || /\b[A-Z0-9]{6,}\b/.test(trimmed) || EXACT_CUES.test(trimmed) || wordCount <= 6;
  const lookupKind: LookupKind = analytical ? "analytical" : exactSignals ? "exact" : "analytical";

  const needsClarification = hasNoSearchableSubject(trimmed);

  return {
    intent,
    lookupKind,
    ...(dateRange ? { dateRange } : {}),
    ...(amount ? { amount } : {}),
    negations,
    documentTypeHints,
    explicitSourceTypes: extractExplicitSourceTypes(trimmed),
    needsClarification,
    ...(needsClarification
      ? { clarificationReason: "The question refers to something earlier or names no subject (for example “what about it?”). AI Search answers one self-contained question at a time." }
      : {}),
    preferredSourceTypes: PREFERRED_SOURCES[intent],
  };
}

/** Local classification used when the model-based rewrite is unavailable or rejected. Replaces the
 * previous blanket "exploratory" default with something derived from the question's own wording. */
export function heuristicPlanFields(query: string, understanding: QueryUnderstanding): { queryType: QueryType; complexity: QueryComplexity } {
  const wordCount = query.trim().split(/\s+/).filter(Boolean).length;
  const compound = /\band\b|\bcompare\b|\bversus\b|\bvs\.?\b/i.test(query) || (query.match(/\?/g)?.length ?? 0) > 1;
  const comparative = /\b(compare|compared|versus|vs\.?|than last|from last|changed?)\b/i.test(query);

  let queryType: QueryType = "exploratory";
  if (comparative) queryType = "comparative";
  else if (understanding.lookupKind === "exact" && understanding.intent !== "general") queryType = "factual";
  else if (understanding.lookupKind === "analytical" && understanding.intent !== "general") queryType = "analytical";

  const complexity: QueryComplexity = compound ? "complex" : wordCount <= 6 ? "simple" : "moderate";
  return { queryType, complexity };
}

const NEGATION_WORDS = ["not", "no", "never", "without", "excluding", "exclude", "except", "besides", "ignoring"];

/** Numeric tokens (amounts, years, dates' parts) as comparable strings: "1,50,000" -> "150000". */
function numericTokens(text: string): string[] {
  return (text.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
}

/** A rewritten phrasing is only safe to search with if it preserves every figure and every negation
 * of the original question. The original query is always searched as well, so dropping an unsafe
 * rewrite costs nothing but a phrasing. */
export function rewritePreservesMeaning(original: string, rewritten: string): boolean {
  const originalNumbers = numericTokens(original);
  const rewrittenNumbers = new Set(numericTokens(rewritten));
  for (const n of originalNumbers) {
    if (!rewrittenNumbers.has(n)) return false;
  }

  const originalWords = new Set(tokenize(original));
  const rewrittenWords = new Set(tokenize(rewritten));
  for (const w of NEGATION_WORDS) {
    if (originalWords.has(w) && !rewrittenWords.has(w)) return false;
  }
  // A rewrite must not introduce a negation the user never wrote.
  for (const w of NEGATION_WORDS) {
    if (rewrittenWords.has(w) && !originalWords.has(w)) return false;
  }
  return true;
}

/** True when every figure in `derived` also appears in `original` (a sub-question may drop figures
 * that belong to a sibling part, but must never introduce one the user did not write). */
export function introducesNoNewFigures(original: string, derived: string): boolean {
  const allowed = new Set(numericTokens(original));
  return numericTokens(derived).every((n) => allowed.has(n));
}
