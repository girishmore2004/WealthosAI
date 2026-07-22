// Deterministic keyword/pattern matching — no LLM, no external API call. Each intent
// maps a family of question phrasings to a single grounded data source. Order matters:
// the first matching pattern wins, so more specific intents should sit before broader
// ones if their keyword sets could ever overlap.
export interface CoachIntent {
  id: string;
  topicLabel: string; // shown to the user in the "what I can answer" refusal message
  patterns: RegExp[];
}

export const COACH_INTENTS: CoachIntent[] = [
  { id: "SUMMARY", topicLabel: "an overall summary of your finances", patterns: [/summar/i, /overall|overview/i, /how am i doing/i] },
  { id: "NEXT_ACTION", topicLabel: "what to do next", patterns: [/what should i do/i, /next action/i, /what.*next\b/i] },
  { id: "WHY_CHANGED", topicLabel: "why something changed", patterns: [/why did.*change/i, /why (is|has|did)/i, /what changed/i] },
  { id: "RISK", topicLabel: "your risk profile", patterns: [/\brisk\b/i] },
  { id: "NET_WORTH", topicLabel: "net worth", patterns: [/net.?worth/i, /how much (am i|are we) worth/i] },
  { id: "SAVINGS_RATE", topicLabel: "savings rate", patterns: [/saving/i] },
  { id: "DEBT", topicLabel: "loans and EMIs", patterns: [/\bdebt\b/i, /\bemi\b/i, /\bloan/i] },
  { id: "GOALS", topicLabel: "financial goals", patterns: [/\bgoal/i] },
  { id: "TAX", topicLabel: "tax estimate", patterns: [/\btax/i] },
  { id: "RETIREMENT", topicLabel: "retirement readiness", patterns: [/retir/i] },
  { id: "INSURANCE", topicLabel: "insurance coverage", patterns: [/insuran/i, /\bcoverage\b/i, /\bpolicy\b/i] },
  { id: "INVESTMENTS", topicLabel: "investment portfolio", patterns: [/invest/i, /portfolio/i, /allocation/i] },
  { id: "SPENDING", topicLabel: "spending by category", patterns: [/\bspend/i, /\bexpense/i, /where.*money.*go/i] },
  { id: "SUBSCRIPTIONS", topicLabel: "recurring subscriptions", patterns: [/subscription/i, /recurring charge/i] },
];

export function matchIntent(question: string): CoachIntent | null {
  return COACH_INTENTS.find((intent) => intent.patterns.some((p) => p.test(question))) ?? null;
}
