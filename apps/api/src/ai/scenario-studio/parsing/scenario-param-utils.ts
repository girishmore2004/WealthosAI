import { ScenarioType } from "@wealthos/types";

export type PromptNumberKind = "percent" | "money" | "years" | "months" | "plain";

export interface PromptNumber {
  /** Money is already scaled to rupees (lakh/crore/k applied); percent is the bare number. */
  value: number;
  kind: PromptNumberKind;
}

/** The only params each scenario type accepts — mirrors SCENARIO_FIELD_HINTS in the parser
 * (and SimulatorService's own required fields). Anything else the model returns, such as an
 * invented `loanId`, is dropped rather than passed downstream. */
export const ALLOWED_SCENARIO_FIELDS: Record<ScenarioType, readonly string[]> = {
  SALARY_HIKE: ["percentIncrease"],
  SALARY_DROP: ["percentDecrease"],
  SIP_INCREASE: ["additionalMonthlyAmount"],
  SIP_DECREASE: ["reducedMonthlyAmount"],
  HOUSE_PURCHASE: ["propertyValue", "downPaymentPercent", "loanInterestRateAnnual", "loanTenureMonths"],
  LOAN_PREPAYMENT: ["lumpSum"],
  RETIREMENT_AGE_SHIFT: ["newRetirementAge"],
  EMERGENCY_EXPENSE: ["amount"],
  GOAL_DELAY: ["delayMonths"],
  NEW_LOAN: ["loanAmount", "annualRatePercent", "tenureMonths", "purpose"],
};

/** The single field whose value fully defines the scenario for single-field types. For
 * HOUSE_PURCHASE and NEW_LOAN the first entry is the headline amount; the remaining fields
 * still need the AI parser (or the user). */
export const PRIMARY_SCENARIO_FIELD: Record<ScenarioType, string> = {
  SALARY_HIKE: "percentIncrease",
  SALARY_DROP: "percentDecrease",
  SIP_INCREASE: "additionalMonthlyAmount",
  SIP_DECREASE: "reducedMonthlyAmount",
  HOUSE_PURCHASE: "propertyValue",
  LOAN_PREPAYMENT: "lumpSum",
  RETIREMENT_AGE_SHIFT: "newRetirementAge",
  EMERGENCY_EXPENSE: "amount",
  GOAL_DELAY: "delayMonths",
  NEW_LOAN: "loanAmount",
};

const PERCENT_FIELDS = new Set(["percentIncrease", "percentDecrease", "downPaymentPercent", "loanInterestRateAnnual", "annualRatePercent"]);
const AMOUNT_FIELDS = new Set(["additionalMonthlyAmount", "reducedMonthlyAmount", "propertyValue", "lumpSum", "amount", "loanAmount"]);
const MONTH_FIELDS = new Set(["delayMonths", "loanTenureMonths", "tenureMonths"]);
const AGE_FIELDS = new Set(["newRetirementAge"]);
const TEXT_FIELDS = new Set(["purpose"]);

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20,
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
  crs: 10_000_000,
  million: 1_000_000,
};

const WORD_PATTERN = Object.keys(NUMBER_WORDS).join("|");
// A number word is only converted when a unit follows ("two years", "five lakh") so ordinary
// English such as "one of my goals" is never read as the number 1.
const WORD_WITH_UNIT = new RegExp(
  `\\b(${WORD_PATTERN})\\s+(years?|yrs?|months?|lakhs?|lacs?|crores?|thousand|percent|per cent)\\b`,
  "gi",
);
const A_LAKH_OR_CRORE = /\ba\s+(lakh|lac|crore)\b/gi;

const TOKEN =
  /(?<![\w.])(₹|rs\.?|inr)?\s?(\d{1,3}(?:,\d{2,3})+(?!\d)|\d+)(\.\d+)?\s?(%|percent|per cent|k|thousand|lakhs?|lacs?|crores?|crs?|cr|million|years?|yrs?|months?)?(?![a-z])/gi;

/** Every figure literally written in the prompt, with its kind. This is the ground truth
 * that an AI-extracted parameter must trace back to: the parser never accepts an amount,
 * rate, age or duration the user did not type. */
export function extractPromptNumbers(prompt: string): PromptNumber[] {
  const text = (prompt ?? "")
    .replace(WORD_WITH_UNIT, (_m, word: string, unit: string) => `${NUMBER_WORDS[word.toLowerCase()]} ${unit}`)
    .replace(A_LAKH_OR_CRORE, (_m, unit: string) => `1 ${unit}`);

  const out: PromptNumber[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const currency = match[1];
    const base = parseFloat(`${match[2].replace(/,/g, "")}${match[3] ?? ""}`);
    if (Number.isNaN(base)) continue;
    const unit = (match[4] ?? "").toLowerCase().replace(/\s+/g, " ");

    if (unit === "%" || unit === "percent" || unit === "per cent") {
      out.push({ value: base, kind: "percent" });
    } else if (/^(years?|yrs?)$/.test(unit)) {
      out.push({ value: base, kind: "years" });
    } else if (/^months?$/.test(unit)) {
      out.push({ value: base, kind: "months" });
    } else if (unit in UNIT_MULTIPLIER) {
      out.push({ value: base * UNIT_MULTIPLIER[unit], kind: "money" });
    } else if (currency) {
      out.push({ value: base, kind: "money" });
    } else {
      out.push({ value: base, kind: "plain" });
    }
  }
  return out;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-6, 0.005 * Math.max(Math.abs(a), Math.abs(b)));
}

/** Whether `value` for `field` is a figure the user actually wrote, in a unit that fits the
 * field (a percentage only supports percent fields, an amount never matches a "%" figure). */
export function isSupportedByPrompt(field: string, value: number, numbers: PromptNumber[]): boolean {
  if (PERCENT_FIELDS.has(field)) {
    return numbers.some((n) => n.kind === "percent" && close(n.value, value));
  }
  if (AMOUNT_FIELDS.has(field)) {
    return numbers.some((n) => (n.kind === "money" || n.kind === "plain") && close(n.value, value));
  }
  if (MONTH_FIELDS.has(field)) {
    return numbers.some(
      (n) =>
        (n.kind === "months" && close(n.value, value)) ||
        (n.kind === "years" && close(n.value * 12, value)) ||
        (n.kind === "plain" && close(n.value, value)),
    );
  }
  if (AGE_FIELDS.has(field)) {
    return numbers.some((n) => (n.kind === "plain" || n.kind === "years") && close(n.value, value));
  }
  return false;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d[\d,]*(\.\d+)?$/.test(value.trim())) {
    const n = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface SanitizedParams {
  params: Record<string, number | string>;
  /** Field names that were removed (unknown for the type, or a number the prompt never stated). */
  dropped: string[];
}

/** Keeps only fields valid for `type`, coerces numeric strings, and drops every numeric value
 * that cannot be traced to a figure written in the prompt — so a model that "helpfully"
 * estimates a property value, a rate or a retirement age cannot smuggle it into a simulation.
 * A dropped field surfaces downstream as an explicit "missing field" request to the user. */
export function sanitizeScenarioParams(
  type: ScenarioType,
  raw: Record<string, unknown> | null | undefined,
  prompt: string,
): SanitizedParams {
  const allowed = new Set(ALLOWED_SCENARIO_FIELDS[type]);
  const numbers = extractPromptNumbers(prompt);
  const params: Record<string, number | string> = {};
  const dropped: string[] = [];

  for (const [field, value] of Object.entries(raw ?? {})) {
    if (!allowed.has(field)) {
      dropped.push(field);
      continue;
    }
    if (TEXT_FIELDS.has(field)) {
      if (typeof value === "string" && value.trim().length > 0) params[field] = value.trim().slice(0, 80);
      else dropped.push(field);
      continue;
    }
    const n = coerceNumber(value);
    if (n !== null && n > 0 && isSupportedByPrompt(field, n, numbers)) params[field] = n;
    else dropped.push(field);
  }
  return { params, dropped };
}

function distinct(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) if (!out.some((o) => close(o, v))) out.push(v);
  return out;
}

/** Deterministically reads the scenario's headline parameter when the prompt states exactly
 * one candidate for it; otherwise returns {} (never a guess). Examples: "salary increases by
 * 10%" -> percentIncrease 10; "prepay ₹2 lakh" -> lumpSum 200000; "retire at 55 instead of 60"
 * -> newRetirementAge 55; "delay by two years" -> delayMonths 24. */
export function extractPrimaryParams(type: ScenarioType, prompt: string): Record<string, number> {
  const field = PRIMARY_SCENARIO_FIELD[type];
  const numbers = extractPromptNumbers(prompt);

  if (PERCENT_FIELDS.has(field)) {
    const percents = distinct(numbers.filter((n) => n.kind === "percent").map((n) => n.value));
    return percents.length === 1 ? { [field]: percents[0] } : {};
  }

  if (AMOUNT_FIELDS.has(field)) {
    let amounts = distinct(numbers.filter((n) => n.kind === "money").map((n) => n.value));
    if (amounts.length === 0) {
      amounts = distinct(numbers.filter((n) => n.kind === "plain" && n.value >= 1000).map((n) => n.value));
    }
    return amounts.length === 1 ? { [field]: amounts[0] } : {};
  }

  if (MONTH_FIELDS.has(field)) {
    const months = distinct(
      numbers
        .filter((n) => n.kind === "months" || n.kind === "years")
        .map((n) => (n.kind === "years" ? n.value * 12 : n.value)),
    );
    return months.length === 1 ? { [field]: months[0] } : {};
  }

  if (AGE_FIELDS.has(field)) {
    const text = (prompt ?? "").toLowerCase();
    const match =
      /\b(?:retire|retiring|retirement)\b[^.?!\d]{0,25}\b(?:at|to|by)\s+(?:the\s+)?(?:age\s+(?:of\s+)?)?(\d{2})\b/.exec(text) ??
      /\bretirement age\s+(?:of|to|at)\s+(\d{2})\b/.exec(text);
    return match ? { [field]: Number(match[1]) } : {};
  }

  return {};
}
