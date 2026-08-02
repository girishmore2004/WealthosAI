// Shared domain types used across apps/api and apps/web.
// Kept framework-agnostic (no Prisma/Nest/React imports) so both can consume it safely.

export type Role = "OWNER" | "MEMBER";
export type TaxRegime = "OLD" | "NEW";
export type RiskProfile = "CONSERVATIVE" | "MODERATE" | "AGGRESSIVE";
export type CategoryType = "NEED" | "WANT" | "SAVINGS";
export type IncomeSource =
  | "SALARY"
  | "FREELANCE"
  | "BUSINESS"
  | "RENT"
  | "DIVIDEND"
  | "INTEREST"
  | "BONUS"
  | "PENSION"
  | "OTHER";
export type Recurrence = "ONE_TIME" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
export type PaymentMethod = "CASH" | "UPI" | "CARD" | "BANK_TRANSFER" | "WALLET" | "OTHER";

export interface UserDTO {
  id: string;
  email: string;
  phone: string | null;
  name: string | null;
  role: Role;
  householdId: string | null;
  taxRegime: TaxRegime;
  riskProfile: RiskProfile;
  createdAt: string;
}

export interface HouseholdDTO {
  id: string;
  name: string;
  members: UserDTO[];
  dependents: DependentDTO[];
}

export interface DependentDTO {
  id: string;
  householdId: string;
  name: string;
  relation: string;
  dateOfBirth: string | null;
}

export interface IncomeDTO {
  id: string;
  userId: string;
  source: IncomeSource;
  label: string;
  amount: string; // decimal serialized as string to avoid float precision issues
  currency: string;
  recurrence: Recurrence;
  receivedAt: string;
  notes: string | null;
}

export interface CategoryDTO {
  id: string;
  name: string;
  type: CategoryType;
  icon: string | null;
  isSystem: boolean;
}

export interface ExpenseDTO {
  id: string;
  userId: string;
  categoryId: string;
  category?: CategoryDTO;
  merchant: string | null;
  amount: string;
  currency: string;
  spentAt: string;
  paymentMethod: PaymentMethod;
  notes: string | null;
  isRecurring: boolean;
}

export interface CategoryBreakdownDTO {
  categoryId: string;
  name: string;
  type: CategoryType;
  total: number;
}

// NOTE: "Subscriptions" is intentionally NOT a first-class trackable entity — there is
// no Subscription model. This is a derived, heuristic view over Expense rows (see
// ExpensesService.detectSubscriptions). See README "Subscriptions" section for the
// reasoning behind that decision.
export type SubscriptionConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface DetectedSubscriptionDTO {
  merchant: string;
  occurrences: number;
  averageAmount: number;
  confidence: SubscriptionConfidence;
  lastSeenAt: string;
  sourceExpenseIds: string[];
}

export interface FinancialHealthScoreDTO {
  score: number;
  breakdown: {
    savingsRate: number;
    debtToIncome: number;
    emergencyFundMonths: number;
    // Previously always 100 (a hardcoded placeholder — see the audit's flagged gap).
    // Now a real, budget-amount-weighted score computed from the user's own
    // per-category budgets whenever budgetAdherenceIsReal is true. When it's false
    // (no budgets configured), this still reports 100 for calculation continuity, but
    // is NOT weighted into `score` above and should not be displayed as a meaningful
    // figure on its own — see budgetAdherenceIsReal.
    budgetAdherence: number;
  };
  band: "STRONG" | "STABLE" | "NEEDS_ATTENTION" | "AT_RISK";
  generatedAt: string;
  // NEW: whether budgetAdherence above reflects real user-defined budgets. false means
  // the user hasn't set any budgets yet — the frontend should show something like "Set
  // a budget to include this in your score" rather than the placeholder number, and
  // `score` itself was computed by redistributing that 15% weight across the other
  // three real dimensions rather than trusting a fabricated value.
  budgetAdherenceIsReal: boolean;
}

export interface DashboardSummaryDTO {
  netWorth: string;
  cashBalance: string;
  monthlyIncome: string;
  monthlyExpenses: string;
  savingsRate: number;
  healthScore: FinancialHealthScoreDTO;
  insights: InsightDTO[];
  investmentsValue: string;
  totalDebt: string;
  propertyValue: string;
  unreadAlertCount: number;
}

export interface InsightDTO {
  id: string;
  title: string;
  detail: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  isProjectionOnly: true;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
}

// --- Phase 2: Investments, Loans, Insurance, Goals -------------------------------

export type InvestmentType =
  | "MUTUAL_FUND"
  | "STOCK"
  | "ETF"
  | "EPF"
  | "PPF"
  | "NPS"
  | "FD"
  | "BOND"
  | "GOLD"
  | "SILVER"
  | "REAL_ESTATE"
  | "CRYPTO"
  | "BUSINESS_EQUITY"
  | "OTHER";
export type RiskLevel = "LOW" | "MODERATE" | "HIGH";
export type Liquidity = "LIQUID" | "SEMI_LIQUID" | "ILLIQUID";
export type LoanType =
  | "HOME"
  | "CAR"
  | "EDUCATION"
  | "PERSONAL"
  | "BUSINESS"
  | "CREDIT_CARD"
  | "FAMILY"
  | "OTHER";
export type InsuranceType =
  | "HEALTH"
  | "TERM"
  | "VEHICLE"
  | "HOME"
  | "PERSONAL_ACCIDENT"
  | "CRITICAL_ILLNESS"
  | "TRAVEL"
  | "BUSINESS";
export type GoalType =
  | "EMERGENCY_FUND"
  | "HOUSE"
  | "LAND"
  | "CAR"
  | "MARRIAGE"
  | "CHILD_EDUCATION"
  | "RETIREMENT"
  | "EARLY_RETIREMENT"
  | "BUSINESS_EXPANSION"
  | "VACATION"
  | "HEALTHCARE_RESERVE"
  | "PASSIVE_INCOME"
  | "FAMILY_SUPPORT"
  | "OTHER";

export interface InvestmentDTO {
  id: string;
  userId: string;
  type: InvestmentType;
  name: string;
  currentValue: string;
  costBasis: string;
  purchaseDate: string;
  riskLevel: RiskLevel;
  liquidity: Liquidity;
  goalId: string | null;
  notes: string | null;
}

export interface InvestmentSummaryDTO {
  totalCurrentValue: string;
  totalCostBasis: string;
  totalGainLoss: string;
  totalGainLossPercent: number;
  allocation: { type: InvestmentType; value: number; percent: number }[];
}

export type RebalanceActionKind = "BUY" | "SELL" | "HOLD";

export interface RebalanceActionDTO {
  type: InvestmentType;
  currentValue: number;
  currentPercent: number;
  // "What you asked for" — the target implied directly by the input percent against the
  // full totalAfterCash. Unchanged meaning from before this change.
  targetPercent: number;
  targetValue: number;
  // "What's actually achievable" — equal to targetPercent/targetValue when nothing in
  // the plan is constrained. When one or more no-sell types can't reach their target,
  // the shortfall is redistributed proportionally across the remaining types by their
  // relative target weights, and BUY/SELL amounts are computed against these effective
  // values instead of the raw target — see InvestmentsService.resolveConstrainedTargets().
  // For a constrained type itself, these equal currentValue/currentPercent (it's locked).
  effectiveTargetPercent: number;
  effectiveTargetValue: number;
  action: RebalanceActionKind;
  amount: number;
  constrained: boolean;
}

export interface RebalancePlanDTO {
  totalCurrentValue: string;
  cashAvailable: string;
  totalAfterCash: string;
  actions: RebalanceActionDTO[];
  totalBuy: string;
  totalSell: string;
}

export interface LoanDTO {
  id: string;
  userId: string;
  type: LoanType;
  lender: string;
  principal: string;
  outstandingPrincipal: string;
  interestRateAnnual: string;
  tenureMonths: number;
  emiAmount: string;
  startDate: string;
  notes: string | null;
}

export interface DebtSummaryDTO {
  totalOutstanding: string;
  totalMonthlyEmi: string;
  debtStressScore: number; // EMI as % of monthly income
  loans: LoanDTO[];
}

export interface InsurancePolicyDTO {
  id: string;
  userId: string;
  type: InsuranceType;
  provider: string;
  policyNumber: string | null;
  premiumAmount: string;
  premiumFrequency: Recurrence;
  coverageAmount: string;
  renewalDate: string;
  nomineeName: string | null;
  notes: string | null;
}

export interface CoverageGapDTO {
  type: InsuranceType;
  hasCoverage: boolean;
  currentCoverage: string;
  recommendedCoverage: string;
  gap: string;
  message: string;
}

export interface GoalDTO {
  id: string;
  userId: string;
  type: GoalType;
  name: string;
  targetAmount: string;
  targetDate: string;
  currentAmount: string;
  monthlyContribution: string;
  linkedInvestmentValue: string;
  requiredMonthlyContribution: number;
  progressPercent: number;
  probabilityOfSuccess: "ON_TRACK" | "AT_RISK" | "OFF_TRACK";
  // NEW: the honest numeric signal behind probabilityOfSuccess — a real ratio
  // (monthlyContribution / requiredMonthlyContribution), not a bucketed label. 1 means
  // "no further contribution is actually needed." Uncapped above 1.
  contributionPaceRatio: number;
  // NEW: explicit, permanent, machine-readable disclosure that probabilityOfSuccess was
  // never a modeled probability — closes the audit's flagged naming concern
  // ("slightly misleading naming for what is a threshold-based rule, not a stochastic
  // estimate") without a breaking rename of the field 4+ existing consumers already
  // match against by exact string value.
  isPaceHeuristic: true;
  // NEW: the linked investment value projected forward to the target date at
  // assumedAnnualReturnPercent (equal to today's linkedInvestmentValue when that's
  // unset/0%) — the actual input requiredMonthlyContribution and probabilityOfSuccess
  // are now computed against.
  projectedInvestmentValueAtTarget: string;
  // NEW: the assumed annual growth rate actually used above, as a percentage string
  // ("0.00" when unset) — surfaces what assumption produced the projection.
  assumedAnnualReturnPercent: string;
}

// --- Phase 3: Tax, Retirement, Alerts, Settings -----------------------------------

export type TaxSection =
  | "SECTION_80C"
  | "SECTION_80D"
  | "SECTION_80CCD_1B"
  | "HRA"
  | "HOME_LOAN_INTEREST"
  | "SECTION_80TTA"
  | "SECTION_80E"
  | "OTHER";

export type AlertType =
  | "EMI_DUE"
  | "INSURANCE_RENEWAL"
  | "BUDGET_OVERSPEND"
  | "GOAL_DELAY"
  | "SUBSCRIPTION_RENEWAL"
  | "DEBT_STRESS"
  | "DOCUMENT_EXPIRY"
  | "BUSINESS_OBLIGATION_DUE";

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";
export type DigestFrequency = "DAILY" | "WEEKLY" | "OFF";
export type Theme = "LIGHT" | "DARK" | "SYSTEM";
export type AppLanguage = "EN" | "HI" | "MR";

export interface TaxDeductionDTO {
  id: string;
  userId: string;
  section: TaxSection;
  description: string;
  amount: string;
  financialYear: string;
}

export interface TaxEstimateDTO {
  financialYear: string;
  grossAnnualIncome: string;
  totalDeductions: string;
  // `surcharge` is new on both regime objects — the surcharge amount actually applied
  // (in rupees, already included in taxPayable), so the UI can show it as its own line
  // item. Zero for any income below the ₹50L threshold, matching every existing case.
  oldRegime: { taxableIncome: string; taxPayable: string; surcharge: string };
  newRegime: { taxableIncome: string; taxPayable: string; surcharge: string };
  recommendedRegime: "OLD" | "NEW";
  savingsFromRecommendedRegime: string;
  deductionsBySection: { section: TaxSection; used: string; limit: string; remainingRoom: string }[];
  yearEndChecklist: string[];
  isProjectionOnly: true;
  // NEW: which financial year's slab configuration was actually used to compute this
  // estimate, and whether it had to be approximated from the latest available year
  // because the requested financialYear isn't in tax-slab-config.ts yet (e.g. a future
  // Budget hasn't been added). Lets the frontend show "using FY2025-26 rates as an
  // estimate" instead of silently presenting potentially-stale slabs with false
  // precision — this is the actual transparency mechanism behind the versioned-config
  // fix, not just an internal implementation detail.
  slabsFinancialYear: string;
  slabsAreEstimated: boolean;
}

export interface RetirementProfileDTO {
  targetRetirementAge: number;
  desiredMonthlyIncomeToday: string;
  inflationRatePercent: string;
  expectedReturnPreRetirementPercent: string;
  expectedReturnPostRetirementPercent: string;
}

export interface RetirementPlanDTO {
  yearsToRetirement: number;
  monthlyIncomeAtRetirement: string;
  corpusRequired: string;
  currentRetirementCorpus: string;
  corpusGap: string;
  requiredMonthlySip: string;
  onTrack: boolean;
  isProjectionOnly: true;
  // NEW: the actual post-retirement drawdown horizon used in corpusRequired's PV
  // calculation — either derived from the profile's lifeExpectancyAge, or the
  // long-standing 25-year default when that field is unset (or not later than
  // targetRetirementAge). isHorizonFromLifeExpectancy tells the frontend which case
  // applied, so it can label the figure accordingly ("based on your life expectancy"
  // vs. "using a standard 25-year assumption").
  drawdownHorizonYears: number;
  isHorizonFromLifeExpectancy: boolean;
  // NEW: how much of monthlyIncomeAtRetirement is expected to be covered by a
  // guaranteed pension/annuity (expectedMonthlyPensionAtRetirement on the profile) —
  // "0.00" when unset, matching the original all-corpus-funded assumption.
  monthlyPensionOffset: string;
  // NEW: monthlyIncomeAtRetirement minus monthlyPensionOffset — the portion that
  // actually has to be funded from the investment corpus, and the true input to
  // corpusRequired's calculation. Equal to monthlyIncomeAtRetirement whenever no
  // pension is assumed.
  netMonthlyIncomeNeededFromCorpus: string;
}

export interface AlertDTO {
  id: string;
  userId: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  dueDate: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface UserSettingsDTO {
  notifyEmail: boolean;
  digestFrequency: DigestFrequency;
  theme: Theme;
  language: AppLanguage;
}

// --- Phase 4: Property, Business Tracker, Document Vault, Reports ----------------

export type PropertyType = "HOUSE" | "APARTMENT" | "PLOT" | "LAND" | "COMMERCIAL" | "RENTAL";

export interface PropertyDTO {
  id: string;
  userId: string;
  type: PropertyType;
  name: string;
  address: string | null;
  currentValue: string;
  purchasePrice: string;
  purchaseDate: string;
  isRented: boolean;
  monthlyRentalIncome: string | null;
  annualMaintenanceCost: string;
  annualPropertyTax: string;
  loanId: string | null;
  insurancePolicyId: string | null;
  notes: string | null;
}

export interface PropertyMetricsDTO {
  currentValue: string;
  purchasePrice: string;
  appreciationPercent: number;
  linkedLoanOutstanding: string | null;
  equity: string;
  rentalYieldPercent: number | null;
  netAnnualCarryCost: string; // maintenance + property tax − annual rental income
}

export interface PropertyPortfolioSummaryDTO {
  totalCurrentValue: string;
  totalEquity: string;
  properties: (PropertyDTO & { metrics: PropertyMetricsDTO })[];
}

export type BusinessTransactionType = "REVENUE" | "EXPENSE" | "OWNER_DRAWING";
export type BusinessEntityType = "SOLE_PROPRIETORSHIP" | "PARTNERSHIP" | "LLP" | "PRIVATE_LIMITED" | "OTHER";
export type ObligationStatus = "PENDING" | "PAID" | "OVERDUE" | "CANCELLED";

export interface BusinessDTO {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  entityType: BusinessEntityType;
  currency: string;
  startedAt: string | null;
  ownershipPercent: string | null;
}

export interface BusinessTransactionDTO {
  id: string;
  businessId: string;
  type: BusinessTransactionType;
  category: string | null;
  amount: string;
  occurredAt: string;
  description: string | null;
  isRecurring: boolean;
}

export interface BusinessObligationDTO {
  id: string;
  businessId: string;
  title: string;
  dueDate: string;
  amount: string | null;
  recurrence: Recurrence;
  vendor: string | null;
  status: ObligationStatus;
  notes: string | null;
}

export interface BusinessSummaryDTO {
  businessId: string;
  month: string; // "YYYY-MM"
  revenue: string;
  expenses: string;
  ownerDrawings: string;
  profit: string;
  trend: { month: string; revenue: number; expenses: number; profit: number }[];
}

export type DocumentCategory =
  | "PAN"
  | "AADHAAR"
  | "SALARY_SLIP"
  | "FORM_16"
  | "INSURANCE_POLICY"
  | "LOAN_DOCUMENT"
  | "MF_STATEMENT"
  | "TAX_RETURN"
  | "PROPERTY_PAPER"
  | "BUSINESS_DOCUMENT"
  | "RECEIPT"
  | "BILL"
  | "OTHER";

export type OcrStatus = "NOT_APPLICABLE" | "PENDING" | "DONE" | "FAILED";

export interface DocumentDTO {
  id: string;
  userId: string;
  category: DocumentCategory;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  tags: string[];
  expiryDate: string | null;
  ocrStatus: OcrStatus;
  ocrText: string | null;
  summary: string | null;
  createdAt: string;
}

export interface MonthlyReportDTO {
  month: string;
  income: string;
  expenses: string;
  netCashflow: string;
  savingsRate: number;
  expensesByCategory: { category: string; amount: string; percentOfTotal: number }[];
}

export interface YearlyReportDTO {
  financialYear: string;
  totalIncome: string;
  totalExpenses: string;
  netSavings: string;
  investmentsCurrentValue: string;
  totalDebtOutstanding: string;
  businessProfit: string | null;
  expensesByCategory: { category: string; amount: string; percentOfTotal: number }[];
}

// --- Phase 5: AI Coach, What-If Simulator, Household views -----------------------

export interface CoachInteractionDTO {
  id: string;
  question: string;
  answer: string;
  matchedIntent: string | null;
  dataSources: string[];
  wasRefused: boolean;
  createdAt: string;
}

export type ScenarioType =
  | "SALARY_HIKE"
  | "SALARY_DROP"
  | "SIP_INCREASE"
  | "SIP_DECREASE"
  | "HOUSE_PURCHASE"
  | "LOAN_PREPAYMENT"
  | "RETIREMENT_AGE_SHIFT"
  | "EMERGENCY_EXPENSE"
  | "GOAL_DELAY";

export interface ScenarioParamsByType {
  SALARY_HIKE: { percentIncrease: number };
  SALARY_DROP: { percentDecrease: number };
  SIP_INCREASE: { additionalMonthlyAmount: number };
  SIP_DECREASE: { reducedMonthlyAmount: number };
  HOUSE_PURCHASE: { propertyValue: number; downPaymentPercent: number; loanInterestRateAnnual: number; loanTenureMonths: number };
  LOAN_PREPAYMENT: { loanId: string; lumpSum: number };
  RETIREMENT_AGE_SHIFT: { newRetirementAge: number };
  EMERGENCY_EXPENSE: { amount: number };
  GOAL_DELAY: { goalId: string; delayMonths: number };
}

// Per-loan snapshot (real rate + EMI, not just the aggregate outstanding figure) so the
// Simulator's projection engine can amortize each loan month-by-month during the
// projection window instead of holding total debt flat. Numeric (not string/Decimal)
// since this feeds directly into the pure engine's arithmetic, not display formatting.
export interface ScenarioLoanSnapshotDTO {
  id: string;
  principal: number; // current outstanding principal
  annualRatePercent: number;
  emi: number;
}

export interface ScenarioBaselineDTO {
  monthlyIncome: number;
  monthlyExpenses: number;
  netWorth: number;
  investmentsValue: number;
  totalDebt: number;
  currentAge: number | null;
  targetRetirementAge: number;
  // Optional so existing/legacy baseline literals (tests, other in-repo constructors)
  // remain valid without updating every call site — the engine treats a missing/empty
  // array as "no loan-level detail available" and falls back to holding `totalDebt`
  // flat, exactly as before this field existed.
  loans?: ScenarioLoanSnapshotDTO[];
  totalMonthlyEmi?: number;
}

export interface ScenarioResultDTO {
  scenarioType: ScenarioType;
  monthlyCashflowDelta: string;
  netWorthDeltaIn5Years: string;
  projectedNetWorthIn5Years: string;
  goalImpact: string;
  assumptions: string[];
  narrative: string;
  isProjectionOnly: true;
}

export interface RunScenarioResponseDTO {
  baseline: ScenarioBaselineDTO;
  result: ScenarioResultDTO;
}

export interface SavedScenarioDTO {
  id: string;
  scenarioType: ScenarioType;
  label: string;
  params: Record<string, unknown>;
  result: ScenarioResultDTO;
  createdAt: string;
}

export interface HouseholdMemberSummaryDTO {
  userId: string;
  name: string | null;
  role: Role;
  monthlyIncome: string;
  monthlyExpenses: string;
  netWorth: string;
  investmentsValue: string;
  propertyValue: string;
  totalDebt: string;
  goalCount: number;
  unreadAlertCount: number;
}

export interface SharedSubscriptionFlagDTO {
  merchant: string;
  memberNames: (string | null)[];
}

export interface HouseholdSummaryDTO {
  householdId: string;
  householdName: string;
  memberCount: number;
  totalMonthlyIncome: string;
  totalMonthlyExpenses: string;
  totalNetWorth: string;
  totalInvestments: string;
  totalDebt: string;
  totalPropertyValue: string;
  totalGoalsTarget: string;
  totalGoalsSaved: string;
  totalBusinessProfitThisMonth: string;
  totalUnreadAlerts: number;
  // Merchants detected as recurring for 2+ different members — flagged rather than
  // merged, since we can't tell from the data alone whether it's genuinely one shared
  // subscription split between people or two separate individual ones.
  possibleSharedSubscriptions: SharedSubscriptionFlagDTO[];
  viewerRole: Role;
  // Per-member breakdown is only populated for OWNER viewers — MEMBER viewers get
  // aggregate totals only, never other members' individual figures. Even for OWNER,
  // this is dashboard-level aggregate detail per member, never raw transaction rows.
  members: HouseholdMemberSummaryDTO[] | null;
}

// --- Phase 10: AI Gateway ops -----------------------------------------------------
// No product-facing page consumes these yet (Phase 10 is infrastructure, not a user
// feature) — they're here so the eventual ops dashboard / RAG / Coach 2.0 frontend
// work in later phases has a shared shape to import from day one rather than
// duplicating it, matching how every other DTO in this file is used.

export interface AiHealthStatsDTO {
  windowMinutes: number;
  totalCalls: number;
  errorCount: number;
  errorRate: number | null;
  cacheHitRate: number | null;
  avgLatencyMs: number | null;
}

export interface AiHealthDTO {
  groqConfigured: boolean;
  lastHourStats: AiHealthStatsDTO;
  queue: Record<string, number>;
  checkedAt: string;
}

export type AiJobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export interface AiJobStatusDTO {
  id: string;
  type: string;
  status: AiJobStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Phase 11: RAG engine ----------------------------------------------------------

export type AiSourceType = "DOCUMENT" | "REPORT" | "COACH_INTERACTION" | "ALERT" | "SNAPSHOT";

export interface AiCitedSourceDTO {
  chunkId: string;
  sourceType: AiSourceType;
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
}

export interface AiSearchFiltersDTO {
  sourceTypes?: AiSourceType[];
  dateFrom?: string;
  dateTo?: string;
}

export interface AiSearchResultDTO {
  query: string;
  rewrittenQueries: string[];
  isMultiHop: boolean;
  subQuestions: string[];
  hasEvidence: boolean;
  answer: string;
  citedSources: AiCitedSourceDTO[];
  retrievalConfidence: number;
  answerConfidence: number | null;
  explanation: string;
}

export interface AiSearchLogDTO {
  id: string;
  query: string;
  answer: string;
  hadEvidence: boolean;
  retrievalConfidence: string;
  answerConfidence: string | null;
  createdAt: string;
}

// --- Phase 12: Agentic Coach --------------------------------------------------------

export type CoachPath = "DETERMINISTIC" | "ADVANCED";

export type AdvancedCoachIntent =
  | "prioritize_actions"
  | "goal_conflict"
  | "risk_tradeoff"
  | "compare_periods"
  | "general_search";

export interface AgenticCoachResultDTO {
  question: string;
  path: CoachPath;
  matchedIntent: string | null;
  advancedIntent: AdvancedCoachIntent | null;
  plan: string[];
  facts: Record<string, unknown>;
  citedSources: string[];
  answer: string;
  confidence: number;
  verificationPassed: boolean;
  staleAdviceNote: string | null;
}

export interface AgenticCoachRunDTO {
  id: string;
  question: string;
  path: CoachPath;
  matchedIntent: string | null;
  advancedIntent: AdvancedCoachIntent | null;
  plan: string[];
  facts: Record<string, unknown>;
  citedSources: string[];
  answer: string;
  confidence: string;
  verificationPassed: boolean;
  staleAdviceNote: string | null;
  createdAt: string;
}

// --- Phase 13: Scenario Studio ------------------------------------------------------

export type ScenarioVariantLabel = "best" | "base" | "worst" | "constrained";

export interface ScenarioVariantDTO {
  label: ScenarioVariantLabel;
  params: Record<string, unknown>;
  run: RunScenarioResponseDTO;
  feasible: boolean;
  feasibilityNote: string;
}

export interface SensitivityPointDTO {
  paramValue: number;
  projectedNetWorthIn5Years: number;
  netWorthDeltaIn5Years: number;
}

export interface SensitivityDimensionDTO {
  dimension: string;
  field: string;
  points: SensitivityPointDTO[];
}

export interface GoalImpactNoteDTO {
  goalId: string;
  goalName: string;
  requiredMonthlyContribution: number;
  helped: boolean;
  note: string;
}

export interface RankedVariantDTO {
  label: ScenarioVariantLabel;
  score: number;
  netWorthDeltaIn5Years: number;
  feasible: boolean;
  feasibilityNote: string;
  goalImpacts: GoalImpactNoteDTO[];
}

export interface ScenarioStudioResultDTO {
  prompt: string;
  understood: boolean;
  scenarioType: ScenarioType | null;
  baseParams: Record<string, unknown>;
  variants: ScenarioVariantDTO[];
  sensitivity: SensitivityDimensionDTO[];
  ranked: RankedVariantDTO[];
  explanation: string;
  explanationConfidence: number;
  verificationPassed: boolean;
}

export interface ScenarioStudioRunDTO {
  id: string;
  prompt: string;
  scenarioType: string;
  baseParams: Record<string, unknown>;
  targetGoalIds: string[];
  variants: Record<string, unknown>[];
  sensitivity: SensitivityDimensionDTO[];
  rankedOrder: ScenarioVariantLabel[];
  explanation: string;
  explanationConfidence: string;
  verificationPassed: boolean;
  createdAt: string;
}

// --- Phase 14: ML Insights -----------------------------------------------------------

export interface ContributingFeatureDTO {
  name: string;
  value: number;
  contribution: number;
}

export interface ModelOutputDTO<T> {
  method: string;
  prediction: T;
  confidence: number;
  contributingFeatures: ContributingFeatureDTO[];
  explanation: string;
}

export interface ExpenseAnomalyDTO {
  transactionId: string;
  categoryName: string;
  amount: number;
  categoryMedian: number;
  zScore: number;
}

export interface CashflowForecastDTO {
  nextMonthProjectedCashflow: number;
  trendSlopePerMonth: number;
  stressRisk: boolean;
}

export interface DebtRiskPredictionDTO {
  riskScore: number;
  tier: "low" | "moderate" | "high" | "severe";
}

export interface GoalSuccessPredictionDTO {
  goalId: string;
  goalName: string;
  successProbability: number;
  // NEW: GoalsService's own threshold-based tier, carried through unchanged so a
  // consumer can display both the statistical read and the rule-based read together
  // instead of the two disagreeing silently across different screens.
  ruleBasedTier: "ON_TRACK" | "AT_RISK" | "OFF_TRACK";
  // NEW: explicit, precomputed agreement flag between successProbability (>=50%) and
  // ruleBasedTier (ON_TRACK/AT_RISK read as "on pace", OFF_TRACK as "not") — lets the
  // UI flag a disagreement without re-deriving the comparison itself.
  agreesWithRuleBasedTier: boolean;
}

export interface DriftPredictionDTO {
  drifted: boolean;
  direction: "improving" | "worsening" | "none";
  recentWindowMeanSavingsRate: number;
  priorWindowMeanSavingsRate: number;
  zStatistic: number;
}

export type BehavioralStateDTO = "high_saving" | "balanced" | "overspending";

export interface MonthSegmentDTO {
  month: string;
  savingsRate: number;
  zScoreVsOwnHistory: number;
  state: BehavioralStateDTO;
}

export interface MlInsightsSummaryDTO {
  anomalies: ModelOutputDTO<ExpenseAnomalyDTO[]>;
  cashflowForecast: ModelOutputDTO<CashflowForecastDTO>;
  debtRisk: ModelOutputDTO<DebtRiskPredictionDTO>;
  goalSuccess: ModelOutputDTO<GoalSuccessPredictionDTO[]>;
  drift: ModelOutputDTO<DriftPredictionDTO>;
  habitSegmentation: ModelOutputDTO<MonthSegmentDTO[]>;
}

// --- Phase 15: Copilot Ingestion -----------------------------------------------------

export type IngestionItemStatus = "PENDING" | "APPROVED" | "REJECTED";
export type DuplicateResolution = "kept_both" | "skipped_duplicate" | "merged";

export interface IngestionReviewItemDTO {
  id: string;
  batchId: string;
  rawLine: string;
  parsedDate: string;
  parsedAmount: string;
  merchantRaw: string;
  merchantNormalized: string;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  categorySuggestionConfidence: string;
  isDuplicateCandidate: boolean;
  duplicateOfExpenseId: string | null;
  duplicateConfidence: string;
  isRecurringCandidate: boolean;
  recurringMatchMerchant: string | null;
  isAnomalyCandidate: boolean;
  anomalyZScore: string | null;
  missingFields: string[];
  overallConfidence: string;
  rationale: string;
  status: IngestionItemStatus;
  resolvedExpenseId: string | null;
  duplicateResolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface IngestionBatchDTO {
  id: string;
  sourceLabel: string;
  rawTextExcerpt: string;
  totalLines: number;
  parsedCount: number;
  unparsedCount: number;
  items: IngestionReviewItemDTO[];
  createdAt: string;
}

export interface IngestionBatchSummaryDTO {
  id: string;
  sourceLabel: string;
  totalLines: number;
  parsedCount: number;
  unparsedCount: number;
  createdAt: string;
  _count: { items: number };
}

export interface ApproveReviewItemInput {
  categoryId?: string;
  amount?: number;
  merchant?: string;
  paymentMethod?: string;
  spentAt?: string;
  notes?: string;
  duplicateResolution?: DuplicateResolution;
}



