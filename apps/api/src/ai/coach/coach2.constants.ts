export type AdvancedCoachIntent =
  | "prioritize_actions"
  | "goal_conflict"
  | "risk_tradeoff"
  | "compare_periods"
  | "general_search";

export const ADVANCED_INTENT_LABELS: [AdvancedCoachIntent, ...AdvancedCoachIntent[]] = [
  "prioritize_actions",
  "goal_conflict",
  "risk_tradeoff",
  "compare_periods",
  "general_search",
];

// Shown to the model as classification instructions — kept next to the type so the
// two can't silently drift apart.
export const ADVANCED_INTENT_DESCRIPTIONS: Record<AdvancedCoachIntent, string> = {
  prioritize_actions:
    "The user wants to know what to focus on first among several open items (alerts, goals) — " +
    "e.g. 'what should I prioritize', 'what matters most right now'.",
  goal_conflict:
    "The user is asking whether their financial goals are realistic together, or whether their " +
    "commitments conflict with what they can actually afford — e.g. 'can I afford all my goals', " +
    "'am I overcommitted'.",
  risk_tradeoff:
    "The user is asking about a tradeoff involving risk — e.g. 'should I pay off debt or invest', " +
    "'is my portfolio too risky', 'should I take on more risk'.",
  compare_periods:
    "The user wants a comparison between two specific time periods — e.g. 'compare this month to " +
    "last month', 'how does this year compare to last year'.",
  general_search:
    "None of the above — a general question best answered by searching the user's own documents, " +
    "reports, and history rather than a specific computed comparison.",
};
