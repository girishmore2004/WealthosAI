
import { ScenarioType } from "@wealthos/types";

export type PromptNumberKind =
  | "percent"
  | "money"
  | "years"
  | "months"
  | "plain";

export interface PromptNumber {
  /** Money is already scaled to rupees (lakh/crore/k applied). */
  value: number;
  kind: PromptNumberKind;
}

/**
 * Only the parameters each scenario type accepts.
 * Keep these fields aligned with SimulatorService validation.
 */
export const ALLOWED_SCENARIO_FIELDS: Record<
  ScenarioType,
  readonly string[]
> = {
  SALARY_HIKE: ["percentIncrease"],
  SALARY_DROP: ["percentDecrease"],
  EXPENSE_REDUCTION: ["percentDecrease"],
  SIP_INCREASE: ["additionalMonthlyAmount"],
  SIP_DECREASE: ["reducedMonthlyAmount"],
  HOUSE_PURCHASE: [
    "propertyValue",
    "downPaymentPercent",
    "loanInterestRateAnnual",
    "loanTenureMonths",
  ],
  LOAN_PREPAYMENT: ["lumpSum"],
  RETIREMENT_AGE_SHIFT: ["newRetirementAge"],
  EMERGENCY_EXPENSE: ["amount"],
  GOAL_DELAY: ["delayMonths"],
  NEW_LOAN: [
    "loanAmount",
    "annualRatePercent",
    "tenureMonths",
    "purpose",
  ],
};

/**
 * The headline parameter for each scenario.
 */
export const PRIMARY_SCENARIO_FIELD: Record<ScenarioType, string> = {
  SALARY_HIKE: "percentIncrease",
  SALARY_DROP: "percentDecrease",
  EXPENSE_REDUCTION: "percentDecrease",
  SIP_INCREASE: "additionalMonthlyAmount",
  SIP_DECREASE: "reducedMonthlyAmount",
  HOUSE_PURCHASE: "propertyValue",
  LOAN_PREPAYMENT: "lumpSum",
  RETIREMENT_AGE_SHIFT: "newRetirementAge",
  EMERGENCY_EXPENSE: "amount",
  GOAL_DELAY: "delayMonths",
  NEW_LOAN: "loanAmount",
};

const PERCENT_FIELDS = new Set([
  "percentIncrease",
  "percentDecrease",
  "downPaymentPercent",
  "loanInterestRateAnnual",
  "annualRatePercent",
]);

const AMOUNT_FIELDS = new Set([
  "additionalMonthlyAmount",
  "reducedMonthlyAmount",
  "propertyValue",
  "lumpSum",
  "amount",
  "loanAmount",
]);

const MONTH_FIELDS = new Set([
  "delayMonths",
  "loanTenureMonths",
  "tenureMonths",
]);

const AGE_FIELDS = new Set(["newRetirementAge"]);
const TEXT_FIELDS = new Set(["purpose"]);

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  eighteen: 18,
  twenty: 20,
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

const WORD_WITH_UNIT = new RegExp(
  `\\b(${WORD_PATTERN})\\s+(years?|yrs?|months?|lakhs?|lacs?|crores?|thousand|percent|per cent)\\b`,
  "gi",
);

const A_LAKH_OR_CRORE = /\ba\s+(lakh|lac|crore)\b/gi;

const TOKEN =
  /(?<![\w.])(₹|rs\.?|inr)?\s?(\d{1,3}(?:,\d{2,3})+(?!\d)|\d+)(\.\d+)?\s?(%|percent|per cent|k|thousand|lakhs?|lacs?|crores?|crs?|cr|million|years?|yrs?|months?)?(?![a-z])/gi;

/**
 * Extracts every explicitly stated number from the user's prompt.
 *
 * The extracted numbers are the only numbers that may be used as
 * user-provided scenario parameters.
 */
export function extractPromptNumbers(prompt: string): PromptNumber[] {
  const text = (prompt ?? "")
    .replace(
      WORD_WITH_UNIT,
      (_match, word: string, unit: string) =>
        `${NUMBER_WORDS[word.toLowerCase()]} ${unit}`,
    )
    .replace(
      A_LAKH_OR_CRORE,
      (_match, unit: string) => `1 ${unit}`,
    );

  const output: PromptNumber[] = [];

  for (const match of text.matchAll(TOKEN)) {
    const currency = match[1];

    const base = parseFloat(
      `${match[2].replace(/,/g, "")}${match[3] ?? ""}`,
    );

    if (!Number.isFinite(base)) continue;

    const unit = (match[4] ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ");

    if (
      unit === "%" ||
      unit === "percent" ||
      unit === "per cent"
    ) {
      output.push({ value: base, kind: "percent" });
    } else if (/^(years?|yrs?)$/.test(unit)) {
      output.push({ value: base, kind: "years" });
    } else if (/^months?$/.test(unit)) {
      output.push({ value: base, kind: "months" });
    } else if (unit in UNIT_MULTIPLIER) {
      output.push({
        value: base * UNIT_MULTIPLIER[unit],
        kind: "money",
      });
    } else if (currency) {
      output.push({ value: base, kind: "money" });
    } else {
      output.push({ value: base, kind: "plain" });
    }
  }

  return output;
}

function close(a: number, b: number): boolean {
  return (
    Math.abs(a - b) <=
    Math.max(1e-6, 0.005 * Math.max(Math.abs(a), Math.abs(b)))
  );
}

function distinct(values: number[]): number[] {
  const output: number[] = [];

  for (const value of values) {
    if (!output.some((existing) => close(existing, value))) {
      output.push(value);
    }
  }

  return output;
}

interface PercentContext {
  subject: RegExp;
  action: RegExp;
}

/**
 * Describes which words must be near a percentage for it to belong
 * to a particular scenario.
 */
const PERCENT_CONTEXTS: Partial<
  Record<ScenarioType, PercentContext>
> = {
  SALARY_HIKE: {
    subject:
      /\b(salary|income|ctc|take[- ]home|paycheck|paycheque|wages?|earnings?|pay)\b/i,
    action:
      /\b(increase|increased|increasing|raise|raised|hike|hiked|boost|boosted|rise|rises|rising|more|extra|additional|higher|grow|growth)\b/i,
  },

  SALARY_DROP: {
    subject:
      /\b(salary|income|ctc|take[- ]home|paycheck|paycheque|wages?|earnings?|pay)\b/i,
    action:
      /\b(decrease|decreased|decreasing|reduce|reduced|reduction|lower|lowered|cut|cuts|drop|dropped|fall|fallen|less|decline)\b/i,
  },

  EXPENSE_REDUCTION: {
    subject:
      /\b(expenses?|spending|monthly costs?|household costs?|living costs?|bills?)\b/i,
    action:
      /\b(decrease|decreased|decreasing|reduce|reduced|reduction|lower|lowered|cut|cuts|drop|dropped|less|save|saving|savings)\b/i,
  },

  SIP_INCREASE: {
    subject:
      /\b(sips?|systematic investment plans?|monthly investments?|monthly contributions?)\b/i,
    action:
      /\b(increase|increased|increasing|raise|raised|boost|boosted|higher|more|additional|extra|step up)\b/i,
  },

  SIP_DECREASE: {
    subject:
      /\b(sips?|systematic investment plans?|monthly investments?|monthly contributions?)\b/i,
    action:
      /\b(decrease|decreased|reduce|reduced|reduction|lower|lowered|cut|drop|dropped|less)\b/i,
  },
};

function getContextualPercentages(
  type: ScenarioType,
  prompt: string,
): number[] {
  const context = PERCENT_CONTEXTS[type];

  if (!context) return [];

  const text = (prompt ?? "").toLowerCase();
  const percentages: number[] = [];

  const percentagePattern =
    /(\d+(?:,\d{1,3})*(?:\.\d+)?)\s*(?:%|percent|per cent)\b/gi;

  for (const match of text.matchAll(percentagePattern)) {
    const index = match.index ?? 0;

    const start = Math.max(0, index - 85);
    const end = Math.min(
      text.length,
      index + match[0].length + 85,
    );

    const surroundingText = text.slice(start, end);

    if (
      context.subject.test(surroundingText) &&
      context.action.test(surroundingText)
    ) {
      const value = Number(match[1].replace(/,/g, ""));

      if (Number.isFinite(value) && value > 0 && value <= 100) {
        percentages.push(value);
      }
    }
  }

  return distinct(percentages);
}

/**
 * Whether a parameter is explicitly supported by a number in the prompt.
 */
export function isSupportedByPrompt(
  field: string,
  value: number,
  numbers: PromptNumber[],
): boolean {
  if (PERCENT_FIELDS.has(field)) {
    return numbers.some(
      (number) =>
        number.kind === "percent" &&
        close(number.value, value),
    );
  }

  if (AMOUNT_FIELDS.has(field)) {
    return numbers.some(
      (number) =>
        (number.kind === "money" || number.kind === "plain") &&
        close(number.value, value),
    );
  }

  if (MONTH_FIELDS.has(field)) {
    return numbers.some(
      (number) =>
        (number.kind === "months" && close(number.value, value)) ||
        (number.kind === "years" &&
          close(number.value * 12, value)) ||
        (number.kind === "plain" && close(number.value, value)),
    );
  }

  if (AGE_FIELDS.has(field)) {
    return numbers.some(
      (number) =>
        (number.kind === "plain" || number.kind === "years") &&
        close(number.value, value),
    );
  }

  return false;
}

/**
 * Type-aware validation prevents a percentage belonging to salary
 * from being incorrectly assigned to an expense or SIP scenario.
 */
function isSupportedByScenarioPrompt(
  type: ScenarioType,
  field: string,
  value: number,
  numbers: PromptNumber[],
  prompt: string,
): boolean {
  if (PERCENT_FIELDS.has(field)) {
    const contextual = getContextualPercentages(type, prompt);

    if (contextual.length > 0) {
      return contextual.some((candidate) => close(candidate, value));
    }

    // A single percentage is safe only when no other percentage
    // appears in the prompt.
    const allPercentages = distinct(
      numbers
        .filter((number) => number.kind === "percent")
        .map((number) => number.value),
    );

    return (
      allPercentages.length === 1 &&
      close(allPercentages[0], value)
    );
  }

  return isSupportedByPrompt(field, value, numbers);
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (
    typeof value === "string" &&
    /^-?\d[\d,]*(\.\d+)?$/.test(value.trim())
  ) {
    const number = Number(value.trim().replace(/,/g, ""));

    return Number.isFinite(number) ? number : null;
  }

  return null;
}

export interface SanitizedParams {
  params: Record<string, number | string>;
  dropped: string[];
}

/**
 * Allows only fields supported by the selected scenario type.
 * Numeric values must be traceable to the user's actual prompt.
 */
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
      if (
        typeof value === "string" &&
        value.trim().length > 0
      ) {
        params[field] = value.trim().slice(0, 80);
      } else {
        dropped.push(field);
      }

      continue;
    }

    const number = coerceNumber(value);

    if (
      number !== null &&
      number > 0 &&
      isSupportedByScenarioPrompt(
        type,
        field,
        number,
        numbers,
        prompt,
      )
    ) {
      params[field] = number;
    } else {
      dropped.push(field);
    }
  }

  return { params, dropped };
}

/**
 * Extracts the headline parameter for a single scenario.
 * Never guesses when multiple possible values exist.
 */
export function extractPrimaryParams(
  type: ScenarioType,
  prompt: string,
): Record<string, number> {
  const field = PRIMARY_SCENARIO_FIELD[type];
  const numbers = extractPromptNumbers(prompt);

  if (PERCENT_FIELDS.has(field)) {
    const contextual = getContextualPercentages(type, prompt);

    if (contextual.length === 1) {
      return { [field]: contextual[0] };
    }

    if (contextual.length > 1) {
      return {};
    }

    const percentages = distinct(
      numbers
        .filter((number) => number.kind === "percent")
        .map((number) => number.value),
    );

    return percentages.length === 1
      ? { [field]: percentages[0] }
      : {};
  }

  if (AMOUNT_FIELDS.has(field)) {
    let amounts = distinct(
      numbers
        .filter((number) => number.kind === "money")
        .map((number) => number.value),
    );

    if (amounts.length === 0) {
      amounts = distinct(
        numbers
          .filter(
            (number) =>
              number.kind === "plain" && number.value >= 1000,
          )
          .map((number) => number.value),
      );
    }

    return amounts.length === 1
      ? { [field]: amounts[0] }
      : {};
  }

  if (MONTH_FIELDS.has(field)) {
    const months = distinct(
      numbers
        .filter(
          (number) =>
            number.kind === "months" ||
            number.kind === "years",
        )
        .map((number) =>
          number.kind === "years"
            ? number.value * 12
            : number.value,
        ),
    );

    return months.length === 1
      ? { [field]: months[0] }
      : {};
  }

  if (AGE_FIELDS.has(field)) {
    const text = (prompt ?? "").toLowerCase();

    const match =
      /\b(?:retire|retiring|retirement)\b[^.?!\d]{0,25}\b(?:at|to|by)\s+(?:the\s+)?(?:age\s+(?:of\s+)?)?(\d{2})\b/.exec(
        text,
      ) ??
      /\bretirement age\s+(?:of|to|at)\s+(\d{2})\b/.exec(
        text,
      );

    return match ? { [field]: Number(match[1]) } : {};
  }

  return {};
}
