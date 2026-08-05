export type AdvancedCoachIntent =
  | "prioritize_actions"
  | "goal_conflict"
  | "risk_tradeoff"
  | "compare_periods"
  | "create_plan"
  | "plan_progress_check"
  | "calculation_request"
  | "general_search";

export const ADVANCED_INTENT_LABELS: [AdvancedCoachIntent, ...AdvancedCoachIntent[]] = [
  "prioritize_actions",
  "goal_conflict",
  "risk_tradeoff",
  "compare_periods",
  "create_plan",
  "plan_progress_check",
  "calculation_request",
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
  create_plan:
    "The user wants to set up or commit to a new multi-step, long-running financial plan with a " +
    "concrete target and timeline — e.g. 'help me pay off my car loan in 18 months', 'I want to save " +
    "₹12 lakh for a house in 3 years', 'set up a plan to hit my retirement goal'. Distinct from " +
    "goal_conflict (which only checks feasibility of EXISTING goals, not create a new tracked plan).",
  plan_progress_check:
    "The user is asking how an existing plan or goal they previously set up is progressing, whether " +
    "they're on track, or wants a status update on a commitment they made earlier — e.g. 'how's my " +
    "loan payoff plan going', 'am I still on track to hit my savings target', 'check my plan progress'.",
  calculation_request:
    "The user wants a specific deterministic financial calculation or hypothetical, not general " +
    "advice — e.g. 'what would my EMI be if I borrowed 5 lakh at 9% for 5 years', 'how much extra " +
    "would I save by prepaying 50000', 'how much do I need to invest monthly to reach 10 lakh in 4 " +
    "years'. Distinct from goal_conflict/risk_tradeoff, which reason over the user's actual existing " +
    "data rather than compute a standalone what-if number.",
  general_search:
    "None of the above — a general question best answered by searching the user's own documents, " +
    "reports, and history rather than a specific computed comparison.",
};

// Free-text labels for CoachPlan.targetMetricType — kept as a small closed set here
// (not a Prisma enum) so PlanMonitorService, FinancialPlanAgentService, and the
// Calculator Agent all resolve the same string to the same live-data source. See
// CoachPlan's schema comment for why this is a label, not a foreign key.
export type CoachPlanTargetMetric =
  | "goal_saved_amount" // tracks Goal.currentAmount + linked investment value toward Goal.targetAmount
  | "loan_outstanding_principal" // tracks Loan.outstandingPrincipal toward 0 (or a partial target)
  | "retirement_corpus_gap" // tracks RetirementPlanDTO.corpusGap toward 0
  | "custom_amount"; // a plan not tied to any existing Goal/Loan/RetirementProfile row

export const COACH_PLAN_TARGET_METRICS: [CoachPlanTargetMetric, ...CoachPlanTargetMetric[]] = [
  "goal_saved_amount",
  "loan_outstanding_principal",
  "retirement_corpus_gap",
  "custom_amount",
];

// How far off the expected linear trajectory (startingValue -> targetValue over
// startingDate -> targetDate) a plan's current metric may drift before
// PlanMonitorService marks it AT_RISK instead of ACTIVE. Expressed as a fraction of
// the total distance originally required (|targetValue - startingValue|), so it scales
// sensibly whether the plan is tracking ₹5,000 or ₹50,00,000.
export const PLAN_AT_RISK_DRIFT_FRACTION = 0.15;
