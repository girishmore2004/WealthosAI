// Shared types for the unified financial AI engine.
//
// The engine NEVER lets a language model produce an authoritative number. Deterministic
// tools return ToolResult objects built from FinancialFactsService; the composer renders
// those facts into text; the numeric verifier then re-checks every figure in that text
// against the same facts before anything is returned.

export type FactBasis = "ACTUAL" | "FORECAST" | "PROJECTED" | "TARGET" | "ESTIMATED";
export type FactPeriod = "MONTHLY" | "YEARLY" | "LIFETIME" | "CUSTOM";

// MONEY   : decimal string in rupees              ("33000.00")
// RATIO   : ratio string where 0.25 means 25%     (displayed once as "25.0%")
// MONTHS  : a number of months                    ("6.00")
// COUNT   : an integer count                      ("3")
export type FactKind = "MONEY" | "RATIO" | "MONTHS" | "COUNT";

export interface FactValue {
  kind: FactKind;
  value: string;
}

export interface ToolWarning {
  code: string;
  severity: "WARNING" | "INFO";
  message: string;
  count: number;
  amount?: string;
}

export interface ToolResult {
  tool: string;
  basis: FactBasis;
  period: FactPeriod;
  asOfDate: string;
  facts: Record<string, FactValue>;
  // Optional labelled rows (e.g. one per insurance policy) so per-item figures are still
  // checked by the verifier, not smuggled into free text.
  rows?: Array<{ label: string; facts: Record<string, FactValue> }>;
  warnings: ToolWarning[];
  // Names of things the tool could not determine (reported to the user, never invented).
  missing: string[];
}

export type FinancialIntent =
  | "FINANCIAL_CALCULATION"
  | "FINANCIAL_SUMMARY"
  | "INVESTMENT_ANALYSIS"
  | "EXPENSE_ANALYSIS"
  | "INCOME_ANALYSIS"
  | "CASH_FLOW"
  | "NET_WORTH"
  | "EMERGENCY_FUND"
  | "INSURANCE"
  | "LOAN"
  | "RETIREMENT"
  | "GOAL"
  | "RECEIVABLES"
  | "EXPENSE_BREAKDOWN"
  | "INVESTMENT_PROJECTION"
  | "TAX"
  | "DOCUMENT_QUERY"
  | "TRANSACTION_QUERY"
  | "SCENARIO"
  | "PLANNING"
  | "GENERAL_FINANCIAL_EDUCATION";

export type CalculationMetric = "INVESTED" | "SPENT" | "EARNED" | "SAVINGS_RATE" | "INVESTMENT_RATE";

export type ScenarioKind = "SIP_CHANGE" | "SALARY_CHANGE" | "EXPENSE_CHANGE" | "UNSUPPORTED";

export interface ScenarioParams {
  kind: ScenarioKind;
  direction: "INCREASE" | "DECREASE";
  // Exactly one of these is set when the question named a size; both null = amount missing.
  amount: string | null; // rupees, positive decimal string
  percent: string | null; // e.g. "10" for 10%
}

// "What will my SIP become in 10 years (at 12%)". annualReturn is a percent string such as "12", or
// null when the question named none (then only each holding's own stored expected return is used).
export interface ProjectionParams {
  years: number;
  annualReturn: string | null;
}

export interface RoutedIntent {
  intent: FinancialIntent;
  metric?: CalculationMetric;
  scenario?: ScenarioParams;
  // "MONTH" (default) or "YEAR" for FINANCIAL_CALCULATION questions that said "this year".
  span?: "MONTH" | "YEAR";
  projection?: ProjectionParams;
}

// Where a question is sent when the deterministic engine deliberately does not answer it.
// Existing capabilities (RAG document search, the legacy/agentic coach, Scenario Studio)
// are preserved — the engine hands off rather than re-implementing them.
export type HandoffTarget = "RAG_SEARCH" | "COACH" | "AGENTIC_COACH" | "SCENARIO_STUDIO" | "GENERAL_EDUCATION";

export interface VerificationIssue {
  code:
    | "UNSUPPORTED_NUMBER"
    | "DOUBLE_PERCENT_SCALE"
    | "TOTALS_DO_NOT_RECONCILE"
    | "BASIS_NOT_LABELED"
    | "PERIOD_MISMATCH";
  detail: string;
}

export interface VerificationResult {
  passed: boolean;
  issues: VerificationIssue[];
}
