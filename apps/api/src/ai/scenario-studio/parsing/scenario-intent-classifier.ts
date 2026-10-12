import { ScenarioType } from "@wealthos/types";

export type ScenarioIntentStatus = "clear" | "ambiguous" | "none";

export interface ScenarioIntent {
  /** "clear": exactly one supported scenario type matches; "ambiguous": more than one
   * matches (or the request is negated), so the caller must ask rather than pick;
   * "none": nothing deterministic matched — the AI parser (if available) decides. */
  status: ScenarioIntentStatus;
  /** Set only when status is "clear". */
  scenarioType: ScenarioType | null;
  /** Every supported type the prompt matched, in a stable order. */
  candidates: ScenarioType[];
}

// A pure, dependency-free pre-classifier for Scenario Studio prompts. It is deliberately
// CONSERVATIVE: it only returns "clear" when exactly one supported scenario type is
// signalled by the combination of a subject (salary, SIP, loan, house, ...) and an action
// (increase, prepay, retire, delay, ...). Anything that signals two scenarios, is negated,
// or signals nothing is never guessed here — "ambiguous" becomes a controlled clarification
// and "none" is left to the AI parser, which may itself answer "unsupported" (null).
//
// These are vocabulary patterns, not a lookup of example sentences: any phrasing that
// combines a recognised subject with a recognised action is classified.

const SCENARIO_ORDER: ScenarioType[] = [
  "SALARY_HIKE",
  "SALARY_DROP",
  "SIP_INCREASE",
  "SIP_DECREASE",
  "HOUSE_PURCHASE",
  "LOAN_PREPAYMENT",
  "RETIREMENT_AGE_SHIFT",
  "EMERGENCY_EXPENSE",
  "GOAL_DELAY",
  "NEW_LOAN",
];

const INCOME_SUBJECT =
  /\b(salary|salaries|income|ctc|take[- ]home|paycheck|paycheque|wages?|earnings?|appraisal|increment|promotion|pay (?:raise|hike|cut))\b/;
// "I earn more" / "if I earn less" carries its own direction, so a bare "earn" is not a subject.
const EARN_MORE = /\bearn\w*\s+(?:\w+\s+)?(?:more|extra)\b/;
const EARN_LESS = /\bearn\w*\s+(?:\w+\s+)?less\b/;
const INCREASE_ACTION =
  /\b(increase[sd]?|increasing|rais(?:e|es|ed|ing)|hike[sd]?|hiking|bump(?:ed|s|ing)?|boost(?:ed|s|ing)?|step(?:s|ped|ping)? up|go(?:es)? up|going up|went up|jump(?:s|ed|ing)?|grow(?:s|ing)?|grew|more|extra|additional|double[sd]?|appraisal|increment|promotion)\b/;
const DECREASE_ACTION =
  /\b(decrease[sd]?|decreasing|reduc(?:e|es|ed|ing|tion)|lower(?:s|ed|ing)?|cut(?:s|ting)?|drop(?:s|ped|ping)?|fall(?:s|ing)?|fell|declin(?:e|es|ed|ing)|slash(?:es|ed|ing)?|scale[sd]? down|scaling down|go(?:es)? down|going down|went down|less|halve[sd]?|shrink(?:s|ing)?|dip(?:s|ped)?)\b/;

const SIP_SUBJECT = /\b(sips?|systematic investment plans?|monthly investments?|monthly contributions?)\b/;

const BUY_ACTION = /\b(buy|buying|bought|purchase|purchasing|afford|acquire|acquiring)\b/;
const PROPERTY_WORD = /\b(house|home|flat|apartment|property|villa|real estate|plot)\b(?!\s+(?:loans?|emis?|insurance))/;
const HOME_LOAN_WORD = /\b(?:home|housing|house|property)\s+loans?\b|\bmortgage\b/;

const PREPAY_STRONG = /\b(prepay\w*|pre-pay\w*|part[- ]?pay\w*|foreclos\w*)\b/;
const PAY_OFF_DOWN = /\bpay(?:ing)?\s+(?:off|down)\b/;
const LOAN_WORD = /\b(loans?|emis?|mortgage|debt|borrowing)\b/;

const RETIRE_WORD = /\b(retire|retires|retiring|retirement|retired)\b/;
const RETIRE_AGE_NUMBER = /\b[4-7]\d\b/;
const RETIRE_SHIFT_CUE =
  /\b(early|earlier|later|delay\w*|postpon\w*|extend\w*|retirement age|age of retirement)\b/;

const URGENCY_WORD = /\b(emergency|unexpected|unplanned|sudden|surprise|urgent|unforeseen)\b/;
const EXPENSE_NOUN =
  /\b(expenses?|costs?|bills?|medical|surgery|hospital\w*|repairs?|accident|treatment|payment|spend\w*)\b/;
const EMERGENCY_FUND_PHRASE = /\bemergency (?:fund|funds|corpus|reserve|reserves)\b/g;

const DELAY_ACTION = /\b(delay\w*|postpon\w*|push(?:ing|ed)? (?:it |this |my )?back|defer\w*|put(?:ting)? off|slip\w*)\b/;
const GOAL_WORD = /\bgoals?\b/;

const NEW_LOAN_EXPLICIT = /\b(?:new|another|additional|fresh)\s+(?:[a-z]+\s+){0,2}loans?\b/;
const NEW_LOAN_VERB =
  /\b(?:take|taking|took|avail|availing|apply(?:ing)?\s+for|get|getting|borrow\w*|raise|raising)\s+(?:an?\s+|another\s+|new\s+)?(?:[a-z]+\s+){0,2}loans?\b/;
const BORROW_WORD = /\bborrow\w*\b/;
const LOAN_TYPE_NOUN = /\b(?:personal|business|car|vehicle|education|gold|top-?up)\s+loans?\b/;

// "I won't increase my SIP", "not going to retire at 55" — the stated intent is the
// opposite of (or at least not) the scenario the action words suggest. Never guess it.
const NEGATION =
  /\b(?:not|never|no longer|won't|will not|don't|do not|doesn't|does not|didn't|cannot|can't)\s+(?:\w+\s+){0,2}(?:increase|raise|hike|reduce|decrease|cut|drop|delay|postpone|prepay|retire|buy|take)\w*/;

// True when `a` and `b` occur within `window` words of each other, in either order, inside the
// same clause (a comma, semicolon, currency symbol or sentence end breaks the chain). Used so an
// action word only counts toward a subject it is actually attached to — "I earn 80,000, increase my
// SIP" must not read "increase" as a salary change.
function near(text: string, a: RegExp, b: RegExp, window = 5): boolean {
  const forward = new RegExp(`${a.source}(?:\\s+\\w+){0,${window}}?\\s+${b.source}`);
  const backward = new RegExp(`${b.source}(?:\\s+\\w+){0,${window}}?\\s+${a.source}`);
  return forward.test(text) || backward.test(text);
}

function normalise(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyScenarioIntent(prompt: string): ScenarioIntent {
  const text = normalise(prompt ?? "");
  if (text.length === 0) return { status: "none", scenarioType: null, candidates: [] };

  const matched = new Set<ScenarioType>();

  // --- Income -------------------------------------------------------------------------
  if (near(text, INCOME_SUBJECT, INCREASE_ACTION) || EARN_MORE.test(text)) matched.add("SALARY_HIKE");
  if (near(text, INCOME_SUBJECT, DECREASE_ACTION) || EARN_LESS.test(text)) matched.add("SALARY_DROP");

  // --- SIP ----------------------------------------------------------------------------
  if (near(text, SIP_SUBJECT, INCREASE_ACTION)) matched.add("SIP_INCREASE");
  if (near(text, SIP_SUBJECT, DECREASE_ACTION)) matched.add("SIP_DECREASE");

  // --- House purchase -----------------------------------------------------------------
  const houseIntent =
    new RegExp(`${BUY_ACTION.source}[^.?!]{0,40}${PROPERTY_WORD.source}`).test(text) ||
    new RegExp(`${PROPERTY_WORD.source}[^.?!]{0,25}\\b(?:purchase|buying)\\b`).test(text);
  if (houseIntent) matched.add("HOUSE_PURCHASE");

  // --- Loan prepayment ----------------------------------------------------------------
  const prepayIntent = PREPAY_STRONG.test(text) || (PAY_OFF_DOWN.test(text) && LOAN_WORD.test(text));
  if (prepayIntent) matched.add("LOAN_PREPAYMENT");

  // --- Retirement age -----------------------------------------------------------------
  const retireIntent = RETIRE_WORD.test(text) && (RETIRE_AGE_NUMBER.test(text) || RETIRE_SHIFT_CUE.test(text));
  if (retireIntent) matched.add("RETIREMENT_AGE_SHIFT");

  // --- Emergency expense --------------------------------------------------------------
  const withoutFundPhrase = text.replace(EMERGENCY_FUND_PHRASE, " ");
  if (URGENCY_WORD.test(withoutFundPhrase) && EXPENSE_NOUN.test(withoutFundPhrase)) {
    matched.add("EMERGENCY_EXPENSE");
  }

  // --- Goal delay ---------------------------------------------------------------------
  // "delay my retirement goal" is a retirement-age shift, not a generic goal delay.
  if (DELAY_ACTION.test(text) && GOAL_WORD.test(text) && !retireIntent) matched.add("GOAL_DELAY");

  // --- New loan -----------------------------------------------------------------------
  const newLoanIntent =
    NEW_LOAN_EXPLICIT.test(text) ||
    NEW_LOAN_VERB.test(text) ||
    BORROW_WORD.test(text) ||
    (LOAN_TYPE_NOUN.test(text) && !prepayIntent);
  if (newLoanIntent) {
    if (houseIntent) {
      // Buying a house already includes its loan (see HOUSE_PURCHASE's own fields) — the
      // NEW_LOAN type is explicitly for borrowing NOT tied to buying property.
      // Nothing to add.
    } else if (HOME_LOAN_WORD.test(text)) {
      // "take a home loan": could be a house purchase or a standalone loan — genuinely
      // ambiguous, so report both rather than pick one.
      matched.add("NEW_LOAN");
      matched.add("HOUSE_PURCHASE");
    } else {
      matched.add("NEW_LOAN");
    }
  }

  const candidates = SCENARIO_ORDER.filter((t) => matched.has(t));

  if (candidates.length === 0) return { status: "none", scenarioType: null, candidates };
  if (candidates.length > 1 || NEGATION.test(text)) return { status: "ambiguous", scenarioType: null, candidates };
  return { status: "clear", scenarioType: candidates[0], candidates };
}
