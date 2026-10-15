// Deterministic reading of a Coach question. No model, no I/O.
//
// Routing is decided HERE, from the user's own words only. Retrieved document text, goal names, OCR output
// and model output never reach this function, so none of them can steer which capabilities run or what the
// Coach is allowed to do. A question this module does not recognise returns kind "defer", and the existing
// Coach 2.0 pipeline (keyword router -> classifier -> gatherer -> composer) answers it exactly as before.

export type CoachQuestionKind =
  | "savings_rate"
  | "category_spend"
  | "top_categories"
  | "emergency_fund"
  | "retirement_on_track"
  | "financial_health"
  | "what_if"
  | "house_affordability"
  | "prepay_vs_sip"
  | "goal_acceleration"
  | "savings_plan"
  | "insurance_document"
  | "document"
  | "clarification"
  | "defer";

export type SimpleScenarioType =
  | "SIP_INCREASE"
  | "SIP_DECREASE"
  | "LOAN_PREPAYMENT"
  | "EMERGENCY_EXPENSE"
  | "SALARY_HIKE"
  | "SALARY_DROP"
  | "RETIREMENT_AGE_SHIFT"
  | "HOUSE_PURCHASE"
  | "NEW_LOAN";

export interface PeriodSpec {
  /** Calendar months (YYYY-MM, UTC — the convention every FinancialFacts figure uses), oldest first. */
  months: string[];
  label: string;
  /** True when the question did not name a period and the current month was assumed. */
  assumed: boolean;
}

export interface WhatIfSpec {
  /** Null when the question is a "what if" the deterministic reader cannot type; Scenario Studio then interprets it. */
  type: SimpleScenarioType | null;
  amount?: number;
  percent?: number;
  age?: number;
  loanHint?: string;
}

export interface HouseSpec {
  price: number;
  horizonMonths: number | null;
  downPaymentPercent?: number;
  annualRatePercent?: number;
  tenureYears?: number;
}

export interface PlanSpec {
  targetAmount: number | null;
  months: number | null;
}

export interface CoachUnderstanding {
  kind: CoachQuestionKind;
  period?: PeriodSpec;
  categoryHint?: string;
  whatIf?: WhatIfSpec;
  house?: HouseSpec;
  plan?: PlanSpec;
  /** Set for `clarification`: the single focused question to ask. */
  clarification?: string;
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20, twentyfive: 25, thirty: 30,
};

const UNIT_MULTIPLIER: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  lacs: 100_000,
  crore: 10_000_000,
  crores: 10_000_000,
  cr: 10_000_000,
  m: 1_000_000,
  million: 1_000_000,
};

export function monthString(year: number, monthIndex0: number): string {
  const d = new Date(Date.UTC(year, monthIndex0, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthsAgo(now: Date, n: number): string {
  return monthString(now.getUTCFullYear(), now.getUTCMonth() - n);
}

/** Replaces spelled-out numbers ("three years", "ten lakh") with digits so one number grammar covers both. */
function normalizeNumberWords(text: string): string {
  return text.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen|twenty|thirty)\b(?=\s*(?:years?|yrs?|months?|lakhs?|lacs?|crores?|k\b|thousand))/gi, (w) => String(NUMBER_WORDS[w.toLowerCase()]));
}

export interface AmountToken {
  value: number;
  hasCurrencyMarker: boolean;
  hasUnit: boolean;
  index: number;
  /** The number measures a duration, percentage or age, not money. */
  nonMoney: boolean;
}

/** Every numeric token with enough context to tell money from years, months, ages and percentages. */
export function extractAmountTokens(raw: string): AmountToken[] {
  const text = normalizeNumberWords(raw);
  const re = /(₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|crores?|cr|million|m)?\b(%)?/gi;
  const tokens: AmountToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isFinite(num)) continue;
    const unit = m[3]?.toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14).toLowerCase();
    const before = text.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
    const nonMoney =
      Boolean(m[4]) ||
      /^\s*(years?|yrs?|months?|days?|weeks?|%|percent|years old|yo)\b/.test(after) ||
      /\b(age|at)\s*$/.test(before) && !m[1] && !unit;
    tokens.push({
      value: unit ? num * (UNIT_MULTIPLIER[unit] ?? 1) : num,
      hasCurrencyMarker: Boolean(m[1]),
      hasUnit: Boolean(unit),
      index: m.index,
      nonMoney,
    });
  }
  return tokens;
}

/** The single rupee amount a question is about: marked amounts first, then the first plausible bare figure. */
export function primaryAmount(raw: string, minBare = 100): number | null {
  const tokens = extractAmountTokens(raw).filter((t) => !t.nonMoney);
  const marked = tokens.find((t) => t.hasCurrencyMarker || t.hasUnit);
  if (marked) return marked.value;
  const bare = tokens.find((t) => t.value >= minBare);
  return bare ? bare.value : null;
}

/** All distinct rupee amounts in order of appearance. */
export function allAmounts(raw: string): number[] {
  return extractAmountTokens(raw)
    .filter((t) => !t.nonMoney && (t.hasCurrencyMarker || t.hasUnit || t.value >= 100))
    .map((t) => t.value);
}

/** A duration in months: "3 years", "18 months", "next year". Null when none is stated. */
export function parseDurationMonths(raw: string): number | null {
  const text = normalizeNumberWords(raw).toLowerCase();
  const m = text.match(/(\d+(?:\.\d+)?)\s*(years?|yrs?|months?)/);
  if (m) {
    const n = parseFloat(m[1]);
    const months = /^m/.test(m[2]) ? n : n * 12;
    return Number.isFinite(months) && months > 0 ? Math.round(months) : null;
  }
  if (/\bnext year\b/.test(text)) return 12;
  if (/\bnext month\b/.test(text)) return 1;
  return null;
}

export function parsePeriod(raw: string, now: Date): PeriodSpec | null {
  const text = raw.toLowerCase();
  if (/\b(last|previous|prior)\s+month\b/.test(text)) {
    const m = monthsAgo(now, 1);
    return { months: [m], label: `last month (${m})`, assumed: false };
  }
  if (/\b(this|current)\s+month\b|\bso far\b/.test(text)) {
    const m = monthsAgo(now, 0);
    return { months: [m], label: `this month so far (${m})`, assumed: false };
  }
  const lastN = text.match(/\b(?:last|past|previous)\s+(\d{1,2}|three|six|twelve)\s+months\b/);
  if (lastN) {
    const n = Math.min(12, Math.max(1, /^\d/.test(lastN[1]) ? parseInt(lastN[1], 10) : NUMBER_WORDS[lastN[1]]));
    // The last N COMPLETE months (the current partial month is not mixed in with full ones).
    const months = Array.from({ length: n }, (_, i) => monthsAgo(now, n - i));
    return { months, label: `the last ${n} complete months (${months[0]} to ${months[months.length - 1]})`, assumed: false };
  }
  const named = text.match(new RegExp(`\\b(${MONTH_NAMES.join("|")})\\b(?:\\s+(\\d{4}))?`));
  if (named) {
    const idx = MONTH_NAMES.indexOf(named[1]);
    let year = named[2] ? parseInt(named[2], 10) : now.getUTCFullYear();
    // "in December" asked in October means the most recent December, not a month that has not happened yet.
    if (!named[2] && idx > now.getUTCMonth()) year -= 1;
    const m = monthString(year, idx);
    return { months: [m], label: m, assumed: false };
  }
  const iso = text.match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
  if (iso) return { months: [`${iso[1]}-${iso[2]}`], label: `${iso[1]}-${iso[2]}`, assumed: false };
  return null;
}

const CATEGORY_STOPWORDS = new Set(["my", "the", "a", "an", "last", "this", "month", "year", "so", "far", "total", "all", "each", "every", "it", "me", "i", "money", "much", "in", "on", "for", "during"]);

/** "How much did I spend on food last month?" -> "food". Null when no category-like word follows on/for. */
export function extractCategoryHint(raw: string): string | null {
  const m = raw.toLowerCase().match(/\b(?:spen[dt]|spending|expenses?|cost|paid|pay)\b[^.?!]*?\b(?:on|for|towards)\s+([a-z][a-z &/-]{1,30}?)(?=\s+(?:last|this|in|during|so far|over|per|each|every)\b|[?.!,]|$)/);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/).filter((w) => !CATEGORY_STOPWORDS.has(w));
  return words.length > 0 ? words.join(" ") : null;
}

function parseWhatIf(text: string): WhatIfSpec {
  const lower = text.toLowerCase();
  const amount = primaryAmount(text, 100) ?? undefined;
  const percentMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/);
  const percent = percentMatch ? parseFloat(percentMatch[1]) : undefined;

  if (/\b(prepay|pre-pay|part[- ]?pay|part[- ]?payment|lump[- ]?sum)\b/.test(lower) || (/\bpay (?:down|off)\b/.test(lower) && /\bloan\b/.test(lower))) {
    const hint = lower.match(/\b(home|house|car|personal|education|business|gold|vehicle|auto)\s+loan\b/);
    return { type: "LOAN_PREPAYMENT", amount, loanHint: hint?.[1] };
  }
  if (/\bsip\b|\bmonthly invest|\binvest(?:ing)? (?:more|less)/.test(lower)) {
    if (/\b(reduce|decrease|cut|lower|drop|stop|pause)\b/.test(lower)) return { type: "SIP_DECREASE", amount };
    return { type: "SIP_INCREASE", amount };
  }
  if (/\b(salary|income|pay)\b/.test(lower) && /\b(hike|raise|increase|rise|bump|grows?|up)\b/.test(lower)) return { type: "SALARY_HIKE", percent };
  if (/\b(salary|income|pay)\b/.test(lower) && /\b(drop|cut|decrease|reduc|lose|loss|falls?|halves)\b/.test(lower)) return { type: "SALARY_DROP", percent };
  if (/\bretire\b/.test(lower)) {
    const ageMatch = lower.match(/\bat\s+(\d{2})\b|\bage\s+(\d{2})\b|\b(\d{2})\s*(?:years? old)?\b/);
    const age = ageMatch ? parseInt(ageMatch[1] ?? ageMatch[2] ?? ageMatch[3], 10) : undefined;
    return { type: "RETIREMENT_AGE_SHIFT", age: age && age >= 30 && age <= 80 ? age : undefined };
  }
  if (/\b(emergency|medical|accident|unexpected|repair)\b/.test(lower) && /\b(expense|bill|cost)\b/.test(lower)) return { type: "EMERGENCY_EXPENSE", amount };
  if (/\b(job loss|lose my job|lost my job|laid off|layoff)\b/.test(lower)) return { type: "SALARY_DROP", percent: 100 };
  if (/\b(house|home|flat|apartment|property)\b/.test(lower) && amount) return { type: "HOUSE_PURCHASE", amount };
  if (/\bnew loan|take (?:a|out a) loan|borrow\b/.test(lower)) return { type: "NEW_LOAN", amount };
  return { type: null, amount };
}

function parseHouse(text: string): HouseSpec | null {
  const price = primaryAmount(text, 100_000);
  if (!price) return null;
  const lower = text.toLowerCase();
  const down = lower.match(/(\d+(?:\.\d+)?)\s*%\s*down|down ?payment (?:of )?(\d+(?:\.\d+)?)\s*%/);
  const rate = lower.match(/(\d+(?:\.\d+)?)\s*%\s*(?:interest|rate|p\.?a\.?)|(?:interest|rate) (?:of|at) (\d+(?:\.\d+)?)\s*%|(?:\bat|@)\s*(\d+(?:\.\d+)?)\s*%(?!\s*down)/);
  const tenure = lower.match(/(?:for|over|tenure of|tenure)\s+(\d{1,2})\s*(?:years?|yrs?)/);
  return {
    price,
    horizonMonths: parseDurationMonths(text),
    downPaymentPercent: down ? parseFloat(down[1] ?? down[2]) : undefined,
    annualRatePercent: rate ? parseFloat(rate[1] ?? rate[2] ?? rate[3]) : undefined,
    tenureYears: tenure ? parseInt(tenure[1], 10) : undefined,
  };
}

export function understandCoachQuestion(question: string, now: Date = new Date()): CoachUnderstanding {
  const text = (question ?? "").trim();
  if (text.length < 3) {
    return { kind: "clarification", clarification: "What would you like to know about your money? For example: \"What is my current savings rate?\"" };
  }
  const lower = normalizeNumberWords(text).toLowerCase();

  // 1. Choices between two uses of money.
  if (/\b(prepay|pre-pay|pay off|pay down|foreclose)\b.*\b(or|vs\.?|versus|instead of|rather than)\b.*\b(sip|invest)/.test(lower) ||
      /\b(sip|invest(?:ing)?)\b.*\b(or|vs\.?|versus|instead of|rather than)\b.*\b(prepay|pre-pay|pay off|pay down|foreclose)/.test(lower)) {
    return { kind: "prepay_vs_sip" };
  }

  // 2. What-if questions (Scenario Studio / Simulator).
  const isWhatIf = /\bwhat (?:if|happens if|would happen if|will happen if)\b|\bwhat(?:'s| is) the impact of\b|\bif i (?:increase|raise|decrease|reduce|cut|prepay|pay off|lose|retire|take|buy|get)\b/.test(lower);
  const isHouse = /\b(house|home|flat|apartment|property)\b/.test(lower);
  if (isWhatIf && !(isHouse && /\b(can i|could i|should i|afford)\b/.test(lower))) {
    return { kind: "what_if", whatIf: parseWhatIf(text) };
  }

  // 3. Affordability of a purchase.
  if (isHouse && /\b(afford|buy|purchase|buying)\b/.test(lower)) {
    const house = parseHouse(text);
    if (house) return { kind: "house_affordability", house };
    return { kind: "clarification", clarification: "What price are you considering for the house (for example ₹40 lakh)? Then I can check it against your income, EMIs, cash and retirement plan." };
  }

  // 4. Creating a plan for a stated target.
  if ((/\b(create|make|build|draft|set up|start|give me)\b.*\bplan\b/.test(lower) || /\bplan\b.*\b(to|for)\b.*\bsave\b/.test(lower) || /\bhelp me save\b/.test(lower) || /\bsave\b.*\b(?:in|within|over|by)\b\s*\d+\s*(?:years?|yrs?|months?)/.test(lower)) &&
      /\b(save|saving|savings|corpus|fund)\b/.test(lower)) {
    return { kind: "savings_plan", plan: { targetAmount: primaryAmount(text, 1000), months: parseDurationMonths(text) } };
  }

  // 5. Reaching a goal sooner.
  if (/\b(reach|achieve|hit|meet|complete|fund)\b.*\bgoals?\b.*\b(faster|sooner|quicker|earlier)\b/.test(lower) || /\bbest way\b.*\bgoals?\b/.test(lower) || /\bspeed up\b.*\bgoals?\b/.test(lower)) {
    return { kind: "goal_acceleration" };
  }

  // 6. Documents.
  if (/\b(insurance|policy)\b/.test(lower) && /\b(uploaded|upload|document|my policy|policy document|explain)\b/.test(lower)) return { kind: "insurance_document" };
  if (/\b(uploaded|my (?:salary slip|payslip|pay slip|statement|loan agreement|policy document|mutual fund statement|document))\b/.test(lower)) return { kind: "document" };

  // 7. Health.
  if (/\bemergency (?:fund|reserve|cash)\b/.test(lower) || /\bemergency\b.*\b(adequa|enough|cover|sufficient)/.test(lower)) return { kind: "emergency_fund" };
  if (/\bretire(?:ment)?\b/.test(lower) && /\b(on track|ready|enough|goal|corpus|plan|ahead|behind)\b/.test(lower)) return { kind: "retirement_on_track" };
  if (/\bfinancially\s+(?:healthy|fit|ok|okay|stable|secure|sound)\b|\bfinancial (?:health|wellness|checkup|check-up)\b|\bhow am i doing\b|\bam i (?:doing )?(?:ok|okay|well)\b/.test(lower)) return { kind: "financial_health" };

  // 8. Facts.
  if (/\bsavings? rate\b|\brate of saving\b|\bhow much (?:am i|do i) (?:saving|save)\b/.test(lower)) return { kind: "savings_rate", period: parsePeriod(text, now) ?? undefined };
  if (/\btop\b.*\b(categor|expense)|\bbiggest\b.*\b(categor|expense|spend)|\blargest\b.*\b(categor|expense|spend)|\bwhere\b.*\bmoney\b.*\bgo(?:ing|es)?\b|\bmost (?:money )?(?:on|spent)/.test(lower)) {
    const period = parsePeriod(text, now);
    return { kind: "top_categories", period: period ?? { months: [monthsAgo(now, 0)], label: `this month so far (${monthsAgo(now, 0)})`, assumed: true } };
  }
  if (/\b(spen[dt]|spending|expenses?|cost|paid)\b/.test(lower)) {
    const hint = extractCategoryHint(text);
    if (hint) {
      const period = parsePeriod(text, now);
      return { kind: "category_spend", categoryHint: hint, period: period ?? { months: [monthsAgo(now, 0)], label: `this month so far (${monthsAgo(now, 0)})`, assumed: true } };
    }
  }

  return { kind: "defer" };
}
