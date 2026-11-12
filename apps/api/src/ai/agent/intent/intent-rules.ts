import { IntentResult } from "../agent.types";

// Rule-based intent understanding. Rules decide first because they are free, deterministic and testable; a model is only
// consulted (AgentIntentService) when the rules are genuinely unsure. `unsupported_action` is decided ONLY here, so no
// phrasing a model could be coaxed with can turn a payment, trade or deletion into a supported action.

const UNSUPPORTED: { id: string; pattern: RegExp }[] = [
  { id: "money_transfer", pattern: /\b(transfer|send|wire|remit|pay)\b[^.?!]{0,50}(₹|\brs\.?\s?\d|\brupees?\b|\binr\b|\d[\d,]*\s?(?:k|lakh|lakhs|crore|cr)\b|\bto (?:my|his|her|their|the)\b)/i },
  { id: "trade", pattern: /\b(buy|sell|purchase|redeem|short|trade|place an? order)\b[^.?!]{0,40}\b(stocks?|shares?|equity|mutual funds?|units?|etfs?|crypto|bitcoin|bonds?|futures|options)\b/i },
  { id: "delete_records", pattern: /\b(delete|remove|erase|wipe|clear|drop)\b[^.?!]{0,40}\b(transactions?|expenses?|incomes?|accounts?|loans?|investments?|records?|data|history|everything)\b/i },
  { id: "payment_setup", pattern: /\b(autopay|auto[- ]?debit|standing instruction|pay (?:my )?(?:bill|emi|premium|loan) (?:now|today))\b/i },
];

const MEMORY_RECALL = /\b(what did (?:we|i|you) (?:decide|discuss|agree|say|conclude|talk about)|what (?:was|were) (?:the|my) (?:decision|plan|recommendation)s?|remind me|last time|previous(?:ly)?|earlier (?:you|we|i)|did i (?:tell|say|mention)|what do you (?:remember|know) about me|what have i told you|my (?:saved )?preferences)\b/i;

const IMPERATIVE_ACTION = /^\s*(?:please\s+|can you\s+|could you\s+)?(create|add|save|set up|setup|make|update|change|modify|edit|record|remind me to|set)\b/i;
const ACTION_NOUN: { tool: NonNullable<IntentResult["actionTool"]>; pattern: RegExp }[] = [
  { tool: "update_goal", pattern: /\b(update|change|modify|edit|adjust|extend)\b[^.?!]{0,40}\bgoal\b/i },
  { tool: "create_goal", pattern: /\b(goal)\b/i },
  { tool: "create_task", pattern: /\b(task|reminder|to-?do|remind me)\b/i },
  { tool: "create_plan", pattern: /\b(plan)\b/i },
];

const PLAN_REQUEST = /\b(plan|roadmap|strategy|steps? to|how (?:do|can|should) i (?:pay off|save|retire|build|reach|get out of)|help me (?:save|retire|pay|reach|build|plan))\b/i;
const SCENARIO = /\b(what (?:happens|would happen|will happen)|what[- ]if|simulations?|if i (?:increase|decrease|raise|cut|reduce|take|buy|prepay|stop|lose|change|get)|simulate|scenario|can i afford|afford (?:a|an|the|to)|prepay|stress[- ]test|salary (?:hike|cut|increase|decrease)|job loss)\b/i;
const DOCUMENT = /\b((?:search|find|look (?:up|through)|read|summari[sz]e|cite)\b[^.?!]{0,40}\b(?:uploaded|attached)\b[^.?!]{0,30}\b(?:documents?|files?|statements?|pdfs?)|uploaded (?:\w+ ){0,3}(?:documents?|files?|statements?|pdfs?)|policy document|my (?:insurance )?polic(?:y|ies)|this (?:policy|document|statement|agreement|contract|pdf|report)|(?:uploaded|attached) (?:document|file|statement|pdf)|bank statement|loan agreement|form ?16|payslip|clause|terms and conditions|what does (?:my|the|this) [a-z ]{0,25}(?:say|state|cover|mention)|explain (?:this|my) [a-z ]{0,25}(?:policy|document|statement|agreement))\b/i;
const FINANCE_WORDS = /\b(audit|review|overview|financial|finances|health check|accounts?|spen[dt]|spending|expenses?|income|salary|net worth|savings?|savings rate|cash ?flow|invest(?:ment|ments|ed)?|sips?|portfolio|loans?|emis?|insurance|premiums?|tax(?:es)?|goals?|emergency fund|balance|budget|categories|category|receivables?|assets?|liabilit(?:y|ies)|compare|anomal(?:y|ies)|forecast|risk|retirement|epf|ppf|nps|dashboard|report)\b/i;
const OWN_DATA = /\b(my|mine|i (?:spent|spend|earn|earned|paid|owe|have|saved|invested)|we spent|our)\b/i;
const GENERAL_QUESTION = /^\s*(what is|what are|what's|explain|define|how does|how do|difference between|meaning of|why do|tell me about)\b/i;

export interface RuleContext {
  hasAttachments: boolean;
}

export function classifyIntentRules(message: string, ctx: RuleContext = { hasAttachments: false }): IntentResult {
  const text = message.trim();
  const make = (intent: IntentResult["intent"], confidence: number, reasons: string[], actionTool?: IntentResult["actionTool"]): IntentResult => ({
    intent,
    confidence,
    reasons,
    source: "rules",
    ...(actionTool ? { actionTool } : {}),
  });

  if (text.length < 2) return make("clarification", 1, ["empty message"]);

  for (const u of UNSUPPORTED) {
    if (u.pattern.test(text)) return make("unsupported_action", 0.95, [`unsupported:${u.id}`]);
  }

  if (MEMORY_RECALL.test(text)) return make("memory_recall", 0.9, ["asks about prior conversations or saved facts"]);

  const imperative = IMPERATIVE_ACTION.test(text);
  const isQuestion = text.endsWith("?") || /^\s*(what|how|why|can|could|should|would|will|is|are|do|does)\b/i.test(text);

  // "Save this approved goal" / "add a goal to save 5 lakh" → an action. "Create a savings plan" → planning (the planner
  // proposes it; the proposal then needs approval).
  if (imperative && !isQuestion) {
    const noun = ACTION_NOUN.find((n) => n.pattern.test(text));
    const wantsPlanProposal = /\b(create|make|build|prepare|draft|design)\b[^.?!]{0,30}\b(savings|retirement|debt|budget|emergency|investment|financial|repayment|payoff|house)[^.?!]{0,20}\bplan\b/i.test(text);
    if (noun && !wantsPlanProposal) return make("action_request", 0.85, [`imperative + ${noun.tool}`], noun.tool);
    if (wantsPlanProposal) return make("planning", 0.85, ["asks for a plan proposal"]);
  }

  if (SCENARIO.test(text)) return make("scenario_analysis", 0.85, ["what-if / affordability wording"]);

  if (DOCUMENT.test(text) || (ctx.hasAttachments && /\b(explain|summari[sz]e|analy[sz]e|read|what|extract|check)\b/i.test(text))) {
    return make("document_question", 0.85, ["refers to a document or statement"]);
  }

  if (PLAN_REQUEST.test(text)) return make("planning", 0.8, ["planning wording"]);

  if (OWN_DATA.test(text) && FINANCE_WORDS.test(text)) return make("financial_analysis", 0.85, ["asks about own financial data"]);
  if (FINANCE_WORDS.test(text) && !GENERAL_QUESTION.test(text)) return make("financial_analysis", 0.7, ["finance terms"]);
  if (GENERAL_QUESTION.test(text)) return make("simple_question", 0.7, ["general knowledge wording"]);
  if (text.split(/\s+/).length <= 2) return make("clarification", 0.8, ["too short to act on"]);
  return make("financial_analysis", 0.4, ["no strong signal"]);
}

/** Confidence below which the model-assisted classifier is consulted. */
export const INTENT_RULES_MIN_CONFIDENCE = 0.6;
