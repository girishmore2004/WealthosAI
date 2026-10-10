import type {
  ScenarioStudioResultDTO,
  ScenarioStudioRunDTO,
  MonteCarloResultDTO,
  OptimizedScenarioDTO,
  OptimizationConstraintsDTO,
  DashboardSummaryDTO,
  DashboardOverviewDTO,
  MonthlyReportDetailDTO,
  YearlyMonthsReportDTO,
  DataHealthReportDTO,
  DocumentDiscrepancyDTO,
  ExpenseDTO,
  CategoryBreakdownDTO,
  DetectedSubscriptionDTO,
  IncomeDTO,
  IncomeHistoryDTO,
  CategoryDTO,
  UserDTO,
  InvestmentDTO,
  InvestmentSummaryDTO,
  RebalancePlanDTO,
  LoanDTO,
  DebtSummaryDTO,
  InsurancePolicyDTO,
  CoverageGapDTO,
  GoalDTO,
  TaxDeductionDTO,
  TaxEstimateDTO,
  RetirementProfileDTO,
  RetirementPlanDTO,
  PagedResult,
  AlertDTO,
  UserSettingsDTO,
  PropertyDTO,
  PropertyPortfolioSummaryDTO,
  BusinessDTO,
  BusinessTransactionDTO,
  BusinessObligationDTO,
  BusinessSummaryDTO,
  DocumentDTO,
  MonthlyReportDTO,
  YearlyReportDTO,
  CoachInteractionDTO,
  ScenarioType,
  RunScenarioResponseDTO,
  SavedScenarioDTO,
  HouseholdSummaryDTO,
  HouseholdDTO,
  DependentDTO,
  AiSearchResultDTO,
  AiSearchFiltersDTO,
  AiSearchLogDTO,
  AiJobStatusDTO,
  AgenticCoachResultDTO,
  AgenticCoachRunDTO,
  MlInsightsSummaryDTO,
  IngestionBatchDTO,
  IngestionBatchSummaryDTO,
  IngestionReviewItemDTO,
  ApproveReviewItemInput,
  ExpenseAnalyticsDTO,
  ExpenseFlowType,
  ExpenseSummaryDTO,
  QuickExpenseResultDTO,
  MoneyFlowDTO,
  ReceivableDTO,
  ReceivableSummaryDTO,
  RecordRepaymentResultDTO,
  RecurrenceDeleteMode,
  AccountTransferDTO,
  EmergencyEntryType,
  EmergencyFundEntryDTO,
  EmergencyFundSummaryDTO,
  EmergencyFundOverviewDTO,
  EmergencyFundLedgerRowDTO,
  InvestmentCashflowDTO,
  InvestmentCashflowType,
  InvestmentValuationDTO,
  InvestmentMetricsDTO,
  InvestmentAnalyticsDTO,
  PortfolioProjectionDTO,
  ProjectionDTO,
  SipScheduleSummaryDTO,
  Recurrence,
} from "@wealthos/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include", // sends the wos_session cookie
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, Array.isArray(body.message) ? body.message.join(", ") : body.message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// Separate from request(): FormData uploads must NOT set Content-Type manually — the
// browser sets it (including the multipart boundary) automatically. Reusing request()
// here would silently corrupt every upload.
async function requestFormData<T>(path: string, formData: FormData, method = "POST"): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method, credentials: "include", body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, Array.isArray(body.message) ? body.message.join(", ") : body.message);
  }
  return res.json();
}

async function downloadFile(path: string): Promise<Blob> {
  const res = await fetch(`${API_URL}${path}`, { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "Could not download this file");
  return res.blob();
}

// Builds "?a=1&b=2" from a params object, skipping undefined / null / empty values, so callers
// never hand-assemble query strings (and never send "undefined" to the API).
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export type ExpensePeriodName = "TODAY" | "YESTERDAY" | "THIS_WEEK" | "LAST_WEEK" | "THIS_MONTH" | "LAST_MONTH" | "THIS_YEAR" | "LAST_YEAR" | "CUSTOM";
export type ExpenseSortName = "NEWEST" | "OLDEST" | "HIGHEST" | "LOWEST";

export interface ExpenseListParams {
  page?: number;
  pageSize?: number;
  categoryId?: string;
  from?: string;
  to?: string;
  period?: ExpensePeriodName;
  today?: string;
  flowType?: ExpenseFlowType;
  paymentMethod?: string;
  sort?: ExpenseSortName;
}

export interface ExpenseAnalyticsParams {
  period?: ExpensePeriodName;
  from?: string;
  to?: string;
  today?: string;
  categoryId?: string;
  flowType?: ExpenseFlowType;
}

export interface QuickExpenseInput {
  categoryId: string;
  amount: number;
  merchant?: string;
  spentAt?: string;
  paymentMethod?: string;
  notes?: string;
  flowType?: ExpenseFlowType;
  recurrence?: string;
  recurrenceEndDate?: string;
}

export interface EmergencyPlanInput {
  // Send ONE kind of target (an amount OR months of essential expenses); sending one clears the other.
  // null clears; omitted leaves it alone.
  targetAmount?: number | null;
  targetMonths?: number | null;
  monthlyContribution?: number | null;
  targetDate?: string | null;
}

export interface UseEmergencyMoneyInput {
  amount: number;
  occurredAt: string;
  reason?: string;
  notes?: string;
  // Present = the money was SPENT: the expense is recorded in the same transaction.
  expense?: { categoryId: string; merchant?: string };
}

export interface CashflowInput {
  type: InvestmentCashflowType;
  amount: number;
  occurredAt: string;
  notes?: string;
}

export interface SipScheduleInput {
  // The amount PER PERIOD (the field keeps its original name for backward compatibility).
  monthlyContribution: number;
  frequency?: Exclude<Recurrence, "ONE_TIME">;
  contributionDay?: number;
  startDate: string;
  endDate?: string;
  active: boolean;
  expectedAnnualReturn?: number;
  // Required by the server when the start date is before this month (past contributions become actuals).
  confirmBackfill?: boolean;
}

export interface ProjectionParams {
  // REQUIRED: the return assumption is always an explicit choice.
  annualReturn: number;
  currentValue?: number;
  contribution?: number;
  frequency?: Exclude<Recurrence, "ONE_TIME">;
  years?: number[];
}

export interface SaleInput {
  saleDate: string;
  proceeds: number;
  costBasisPortion: number;
  notes?: string;
  // Also record the SALE cashflow so the proceeds reach cash, atomically with the tax record.
  alsoRecordCashflow?: boolean;
}

export interface RecurrenceRuleInput {
  recurrence?: string;
  endDate?: string;
  clearEndDate?: boolean;
  amount?: number;
  categoryId?: string;
  merchant?: string;
  paymentMethod?: string;
  notes?: string;
}

export interface CreateReceivableInput {
  person: string;
  amount: number;
  givenAt: string;
  purpose?: string;
  expectedReturnAt?: string;
  paymentMethod?: string;
  notes?: string;
}

export interface RecordRepaymentInput {
  amount: number;
  returnedAt: string;
  paymentMethod?: string;
  notes?: string;
  // Re-sending the same key records ONE repayment (guards double-clicks and retries).
  idempotencyKey?: string;
}

export const api = {
  auth: {
    requestOtp: (email: string) =>
      request<{ message: string; isNewUser: boolean }>("/auth/otp/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    verifyOtp: (email: string, code: string) =>
      request<{ user: UserDTO }>("/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({ email, code }),
      }),
    me: () => request<{ user: UserDTO }>("/auth/me"),
    logout: () => request<{ message: string }>("/auth/logout", { method: "POST" }),
  },
  dashboard: {
    summary: () => request<DashboardSummaryDTO>("/dashboard/summary"),
    // Money-flow overview: every figure is ACTUAL and comes from the same facts as the reports.
    overview: () => request<DashboardOverviewDTO>("/dashboard/overview"),
  },
  // NEW: authoritative financial-core read surface (reconciliation / data health).
  financialCore: {
    dataHealth: () => request<DataHealthReportDTO>("/financial-core/data-health"),
    // WHERE DID MY MONEY GO? One month split into expenses / investments / emergency fund /
    // receivables / other outflow, with internal transfers shown separately.
    moneyFlow: (month?: string) => request<MoneyFlowDTO>(`/financial-core/money-flow${qs({ month })}`),
  },
  // Money given that is expected back. Never an expense: cash falls, a receivable asset rises.
  receivables: {
    list: (scope?: "ALL" | "ACTIVE" | "CLOSED" | "CANCELLED") => request<ReceivableDTO[]>(`/receivables${qs({ scope })}`),
    summary: () => request<ReceivableSummaryDTO>("/receivables/summary"),
    get: (id: string) => request<ReceivableDTO>(`/receivables/${id}`),
    create: (data: CreateReceivableInput) => request<ReceivableDTO>("/receivables", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: Partial<CreateReceivableInput>) =>
      request<ReceivableDTO>(`/receivables/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    recordRepayment: (id: string, data: RecordRepaymentInput) =>
      request<RecordRepaymentResultDTO>(`/receivables/${id}/repayments`, { method: "POST", body: JSON.stringify(data) }),
    removeRepayment: (id: string, repaymentId: string) =>
      request<ReceivableDTO>(`/receivables/${id}/repayments/${repaymentId}`, { method: "DELETE" }),
    cancel: (id: string) => request<ReceivableDTO>(`/receivables/${id}/cancel`, { method: "POST" }),
    remove: (id: string) => request<{ deleted: true }>(`/receivables/${id}`, { method: "DELETE" }),
  },
  // Money moved between the user's OWN accounts: not income, not an expense, not an investment.
  transfers: {
    list: (params: { from?: string; to?: string } = {}) => request<AccountTransferDTO[]>(`/transfers${qs({ ...params })}`),
    create: (data: { fromAccount: string; toAccount: string; amount: number; transferredAt: string; notes?: string }) =>
      request<AccountTransferDTO>("/transfers", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<{ deleted: true }>(`/transfers/${id}`, { method: "DELETE" }),
  },
  // Reserved cash, tracked separately from expenses. Coverage maths lives on the server.
  emergencyFund: {
    summary: () => request<EmergencyFundSummaryDTO>("/emergency-fund/summary"),
    // Everything the page shows in one call: balance, coverage, target, progress, plan, totals, trend.
    overview: () => request<EmergencyFundOverviewDTO>("/emergency-fund/overview"),
    // The history, newest first, each row with the balance after it.
    ledger: () => request<EmergencyFundLedgerRowDTO[]>("/emergency-fund/ledger"),
    entries: () => request<EmergencyFundEntryDTO[]>("/emergency-fund/entries"),
    create: (data: { type: EmergencyEntryType; amount: number; occurredAt: string; reason?: string; notes?: string }) =>
      request<EmergencyFundEntryDTO>("/emergency-fund/entries", { method: "POST", body: JSON.stringify(data) }),
    // USE MONEY: a withdrawal, optionally with the genuine expense it paid for, in one transaction.
    use: (data: UseEmergencyMoneyInput) =>
      request<{ entry: EmergencyFundEntryDTO; expense: ExpenseDTO | null }>("/emergency-fund/use", { method: "POST", body: JSON.stringify(data) }),
    setPlan: (data: EmergencyPlanInput) => request<unknown>("/emergency-fund/plan", { method: "PUT", body: JSON.stringify(data) }),
    remove: (id: string) => request<{ deleted: true }>(`/emergency-fund/entries/${id}`, { method: "DELETE" }),
  },
  income: {
    list: () => request<IncomeDTO[]>("/income"),
    // NEW (audit item #16): opt-in paginated variant, now actually used by the Income
    // page's transaction table (see IncomePage) instead of only existing as an unused
    // backend capability. list() above is untouched — still used wherever the full,
    // unbounded set is genuinely needed (e.g. Dashboard/Reports aggregates).
    listPaged: (params: { page?: number; pageSize?: number; from?: string; to?: string } = {}) => {
      const qs = new URLSearchParams();
      if (params.page) qs.set("page", String(params.page));
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));
      if (params.from) qs.set("from", params.from);
      if (params.to) qs.set("to", params.to);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return request<PagedResult<IncomeDTO>>(`/income/paged${suffix}`);
    },
    create: (data: { source: string; label: string; amount: number; recurrence: string; receivedAt: string; notes?: string }) =>
      request<IncomeDTO>("/income", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/income/${id}`, { method: "DELETE" }),
    update: (id: string, data: Partial<{ source: string; label: string; amount: number; recurrence: string; receivedAt: string; notes: string; effectiveFrom: string }>) =>
      request<IncomeDTO>(`/income/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    // NEW (audit item #3): opt-in recurring-generation controls.
    activateRecurrence: (id: string, endDate?: string) =>
      request<IncomeDTO>(`/income/${id}/recurrence/activate`, { method: "POST", body: JSON.stringify({ endDate }) }),
    deactivateRecurrence: (id: string) => request<IncomeDTO>(`/income/${id}/recurrence/deactivate`, { method: "POST" }),
    previewRecurrence: (id: string) => request<{ occurrenceDate: string }[]>(`/income/${id}/recurrence/preview`),
    // NEW (audit item #4): effective-dated salary/amount-change history.
    history: (id: string) => request<IncomeHistoryDTO[]>(`/income/${id}/history`),
  },
  expenses: {
    list: (month?: string) => request<ExpenseDTO[]>(`/expenses${month ? `?month=${month}` : ""}`),
    // NEW (audit item #16): same rationale as income.listPaged() above.
    listPaged: (params: ExpenseListParams = {}) =>
      request<PagedResult<ExpenseDTO>>(`/expenses/paged${qs({ ...params })}`),
    // Today / this month / this year totals in one cheap call (the page header).
    summary: (today?: string, flowType?: ExpenseFlowType) =>
      request<ExpenseSummaryDTO>(`/expenses/summary${qs({ today, flowType })}`),
    // Aggregated analytics (daily/weekly/monthly series, categories, extremes, comparisons).
    // Pass categoryId for a category drill-down.
    analytics: (params: ExpenseAnalyticsParams = {}) =>
      request<ExpenseAnalyticsDTO>(`/expenses/analytics${qs({ ...params })}`),
    // Quick Expense: defaults to today / UPI and returns what the new expense changed.
    quickCreate: (data: QuickExpenseInput) =>
      request<QuickExpenseResultDTO>("/expenses/quick", { method: "POST", body: JSON.stringify(data) }),
    categories: () => request<CategoryDTO[]>("/categories"),
    create: (data: {
      categoryId: string;
      merchant?: string;
      amount: number;
      spentAt: string;
      paymentMethod: string;
      notes?: string;
      flowType?: ExpenseFlowType;
    }) => request<ExpenseDTO>("/expenses", { method: "POST", body: JSON.stringify(data) }),
    // mode (recurring expenses only): THIS (default) deletes one row; FUTURE deletes an auto-generated
    // occurrence and every later one (the rule and earlier history are kept). Deleting the template of
    // an ACTIVE recurrence is refused by the server — stop the recurrence first.
    remove: (id: string, mode?: RecurrenceDeleteMode) =>
      request<void>(`/expenses/${id}${qs({ mode })}`, { method: "DELETE" }),
    // scope (recurring expenses only): THIS (default) edits one row; FUTURE edits it, every later
    // generated occurrence and the rule for ones not yet generated. Earlier rows never change.
    update: (
      id: string,
      data: Partial<{ categoryId: string; merchant: string; amount: number; spentAt: string; paymentMethod: string; notes: string }>,
      scope?: "THIS" | "FUTURE",
    ) => request<ExpenseDTO>(`/expenses/${id}${qs({ scope })}`, { method: "PATCH", body: JSON.stringify(data) }),
    // Edits the repeat RULE only (cadence, end date, amount …); never changes an existing expense.
    updateRule: (id: string, data: RecurrenceRuleInput) =>
      request<ExpenseDTO>(`/expenses/${id}/recurrence`, { method: "PATCH", body: JSON.stringify(data) }),
    subscriptions: () => request<DetectedSubscriptionDTO[]>("/expenses/subscriptions"),
    breakdown: (month?: string) =>
      request<CategoryBreakdownDTO[]>(`/expenses/breakdown${month ? `?month=${month}` : ""}`),
    // NEW (audit item #3): opt-in recurring-generation controls. Unlike income,
    // activation requires the cadence — Expense had no recurrence field before this.
    activateRecurrence: (id: string, recurrence: string, endDate?: string) =>
      request<ExpenseDTO>(`/expenses/${id}/recurrence/activate`, { method: "POST", body: JSON.stringify({ recurrence, endDate }) }),
    deactivateRecurrence: (id: string) => request<ExpenseDTO>(`/expenses/${id}/recurrence/deactivate`, { method: "POST" }),
    previewRecurrence: (id: string) => request<{ occurrenceDate: string }[]>(`/expenses/${id}/recurrence/preview`),
  },
  investments: {
    list: () => request<InvestmentDTO[]>("/investments"),
    summary: () => request<InvestmentSummaryDTO>("/investments/summary"),
    create: (data: {
      type: string;
      name: string;
      currentValue: number;
      costBasis: number;
      purchaseDate: string;
      riskLevel?: string;
      liquidity?: string;
      goalId?: string;
    }) => request<InvestmentDTO>("/investments", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/investments/${id}`, { method: "DELETE" }),
    update: (id: string, data: Partial<{ type: string; name: string; currentValue: number; costBasis: number; purchaseDate: string; riskLevel: string; liquidity: string; goalId: string; notes: string }>) =>
      request<InvestmentDTO>(`/investments/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    rebalance: (data: { targets: { type: string; percent: number }[]; cashAvailable?: number; noSellTypes?: string[] }) =>
      request<RebalancePlanDTO>("/investments/rebalance", { method: "POST", body: JSON.stringify(data) }),

    // --- ledger: every contribution, withdrawal, sale, dividend, fee … for one holding ---
    cashflows: (id: string) => request<InvestmentCashflowDTO[]>(`/investments/${id}/cashflows`),
    addCashflow: (id: string, data: CashflowInput) =>
      request<InvestmentCashflowDTO>(`/investments/${id}/cashflows`, { method: "POST", body: JSON.stringify(data) }),
    removeCashflow: (id: string, cashflowId: string) => request<{ deleted: true }>(`/investments/${id}/cashflows/${cashflowId}`, { method: "DELETE" }),
    // --- dated valuations: what the holding was WORTH (a valuation is never a contribution) ---
    valuations: (id: string) => request<InvestmentValuationDTO[]>(`/investments/${id}/valuations`),
    addValuation: (id: string, data: { value: number; valuedAt: string }) =>
      request<InvestmentValuationDTO>(`/investments/${id}/valuations`, { method: "POST", body: JSON.stringify(data) }),
    metrics: (id: string) => request<InvestmentMetricsDTO>(`/investments/${id}/metrics`),
    // --- recurring contributions (SIP) ---
    sipSchedule: (id: string) => request<SipScheduleSummaryDTO>(`/investments/${id}/sip-schedule`),
    setSipSchedule: (id: string, data: SipScheduleInput) =>
      request<InvestmentDTO>(`/investments/${id}/sip-schedule`, { method: "PUT", body: JSON.stringify(data) }),
    generateSip: (id: string) => request<{ created: string[]; alreadyExisted: string[] }>(`/investments/${id}/sip/generate`, { method: "POST" }),
    generateAllSip: () => request<unknown>("/investments/sip/generate", { method: "POST" }),
    // --- a sale: tax record, optionally with the cash effect in the same atomic write ---
    recordSale: (id: string, data: SaleInput) =>
      request<unknown>(`/investments/${id}/realized-gains`, { method: "POST", body: JSON.stringify(data) }),
    // --- ACTUAL ledger-derived trends and allocation ---
    analytics: (months?: number) => request<InvestmentAnalyticsDTO>(`/investments/analytics${qs({ months })}`),
    // --- PROJECTIONS (assumptions, never actuals, never guarantees) ---
    projection: (p: ProjectionParams) =>
      request<ProjectionDTO>(`/investments/projection${qs({ annualReturn: p.annualReturn, currentValue: p.currentValue, contribution: p.contribution, frequency: p.frequency, years: p.years?.join(",") })}`),
    portfolioProjection: (p: { annualReturn?: number; years?: number[] } = {}) =>
      request<PortfolioProjectionDTO>(`/investments/projection/portfolio${qs({ annualReturn: p.annualReturn, years: p.years?.join(",") })}`),
  },
  loans: {
    list: () => request<LoanDTO[]>("/loans"),
    summary: () => request<DebtSummaryDTO>("/loans/summary"),
    payoffOrder: (strategy: "snowball" | "avalanche" = "avalanche") =>
      request<{ priority: number; loan: LoanDTO }[]>(`/loans/payoff-order?strategy=${strategy}`),
    create: (data: {
      type: string;
      lender: string;
      principal: number;
      outstandingPrincipal: number;
      interestRateAnnual: number;
      tenureMonths: number;
      emiAmount: number;
      startDate: string;
      notes?: string;
    }) => request<LoanDTO>("/loans", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/loans/${id}`, { method: "DELETE" }),
    update: (
      id: string,
      data: Partial<{
        type: string;
        lender: string;
        principal: number;
        outstandingPrincipal: number;
        interestRateAnnual: number;
        tenureMonths: number;
        emiAmount: number;
        startDate: string;
        notes: string;
      }>,
    ) => request<LoanDTO>(`/loans/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    amortization: (id: string) => request<{ month: number; emi: number; interest: number; principal: number; balance: number }[]>(`/loans/${id}/amortization`),
    prepaymentImpact: (id: string, lumpSum: number) =>
      request<{ monthsSaved: number; interestSaved: number; originalTenureMonths: number; newTenureMonths: number }>(
        `/loans/${id}/prepayment-impact?lumpSum=${lumpSum}`,
      ),
  },
  insurance: {
    // Premium per policy and total recorded, from the expenses linked to each policy.
    premiumSummary: () =>
      request<Array<{ policyId: string; premiumAmount: string; premiumFrequency: string; premiumsRecorded: number; totalPaid: string }>>("/insurance/premiums/summary"),
    // The one idempotent way to record a premium: recording the same period twice adds nothing.
    recordPremium: (policyId: string, body: { paidAt?: string; period?: string } = {}) =>
      request<{ created: boolean; expenseId: string; period: string }>(`/insurance/${policyId}/premiums`, { method: "POST", body: JSON.stringify(body) }),
    list: () => request<InsurancePolicyDTO[]>("/insurance"),
    gapAnalysis: () => request<CoverageGapDTO[]>("/insurance/gap-analysis"),
    renewals: (withinDays?: number) => request<InsurancePolicyDTO[]>(`/insurance/renewals${withinDays ? `?withinDays=${withinDays}` : ""}`),
    nomineeSummary: () =>
      request<{
        totalPolicies: number;
        withNominee: number;
        missingNominee: { id: string; provider: string; type: string }[];
        linkedToDependent: number;
      }>("/insurance/nominee-summary"),
    create: (data: {
      type: string;
      provider: string;
      policyNumber?: string;
      premiumAmount: number;
      premiumFrequency: string;
      coverageAmount: number;
      renewalDate: string;
      nomineeName?: string;
      nomineeDependentId?: string;
      notes?: string;
    }) => request<InsurancePolicyDTO>("/insurance", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/insurance/${id}`, { method: "DELETE" }),
    update: (
      id: string,
      data: Partial<{
        type: string;
        provider: string;
        policyNumber: string;
        premiumAmount: number;
        premiumFrequency: string;
        coverageAmount: number;
        renewalDate: string;
        nomineeName: string;
        // string | null (not just string): null explicitly clears an existing link —
        // see ProtectPage.onUpdate() for why this needs to be distinguishable from
        // "field omitted, don't touch."
        nomineeDependentId: string | null;
        notes: string;
      }>,
    ) => request<InsurancePolicyDTO>(`/insurance/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  },
  goals: {
    list: () => request<GoalDTO[]>("/goals"),
    create: (data: {
      type: string;
      name: string;
      targetAmount: number;
      targetDate: string;
      currentAmount?: number;
      monthlyContribution?: number;
      assumedAnnualReturnPercent?: number;
    }) => request<GoalDTO>("/goals", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/goals/${id}`, { method: "DELETE" }),
    update: (
      id: string,
      data: Partial<{
        type: string;
        name: string;
        targetAmount: number;
        targetDate: string;
        currentAmount: number;
        monthlyContribution: number;
        assumedAnnualReturnPercent: number;
      }>,
    ) => request<GoalDTO>(`/goals/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  },
  tax: {
    deductions: (financialYear?: string) => request<TaxDeductionDTO[]>(`/tax/deductions${financialYear ? `?financialYear=${financialYear}` : ""}`),
    estimate: (financialYear?: string) => request<TaxEstimateDTO>(`/tax/estimate${financialYear ? `?financialYear=${financialYear}` : ""}`),
    addDeduction: (data: { section: string; description: string; amount: number; financialYear: string }) =>
      request<TaxDeductionDTO>("/tax/deductions", { method: "POST", body: JSON.stringify(data) }),
    removeDeduction: (id: string) => request<void>(`/tax/deductions/${id}`, { method: "DELETE" }),
  },
  retirement: {
    profile: () => request<RetirementProfileDTO>("/retirement/profile"),
    updateProfile: (data: {
      targetRetirementAge?: number;
      desiredMonthlyIncomeToday?: number;
      inflationRatePercent?: number;
      expectedReturnPreRetirementPercent?: number;
      expectedReturnPostRetirementPercent?: number;
    }) => request<RetirementProfileDTO>("/retirement/profile", { method: "PATCH", body: JSON.stringify(data) }),
    plan: () => request<RetirementPlanDTO>("/retirement/plan"),
  },
  alerts: {
    list: (unreadOnly?: boolean) => request<AlertDTO[]>(`/alerts${unreadOnly ? "?unreadOnly=true" : ""}`),
    refresh: () => request<AlertDTO[]>("/alerts/refresh", { method: "POST" }),
    markRead: (id: string) => request<void>(`/alerts/${id}/read`, { method: "PATCH" }),
    dismiss: (id: string) => request<void>(`/alerts/${id}`, { method: "DELETE" }),
  },
  settings: {
    get: () => request<UserSettingsDTO>("/settings"),
    update: (data: Partial<UserSettingsDTO>) =>
      request<UserSettingsDTO>("/settings", { method: "PATCH", body: JSON.stringify(data) }),
  },
  users: {
    exportData: () => request<Record<string, unknown>>("/users/me/export"),
    deleteAccount: () => request<void>("/users/me", { method: "DELETE" }),
  },
  property: {
    list: () => request<PropertyDTO[]>("/property"),
    summary: () => request<PropertyPortfolioSummaryDTO>("/property/summary"),
    create: (data: {
      type: string;
      name: string;
      address?: string;
      currentValue: number;
      purchasePrice: number;
      purchaseDate: string;
      isRented?: boolean;
      monthlyRentalIncome?: number;
      annualMaintenanceCost?: number;
      annualPropertyTax?: number;
      loanId?: string;
      insurancePolicyId?: string;
      notes?: string;
    }) => request<PropertyDTO>("/property", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/property/${id}`, { method: "DELETE" }),
    update: (id: string, data: Partial<{ type: string; name: string; address: string; currentValue: number; purchasePrice: number; purchaseDate: string; isRented: boolean; monthlyRentalIncome: number; annualMaintenanceCost: number; annualPropertyTax: number; loanId: string; insurancePolicyId: string; notes: string }>) =>
      request<PropertyDTO>(`/property/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    // NEW (audit item #10): opt-in rent -> personal Income sync.
    enableRentIncomeSync: (id: string) =>
      request<{ propertyId: string; income: IncomeDTO }>(`/property/${id}/sync-rent-to-income`, { method: "POST" }),
    disableRentIncomeSync: (id: string) =>
      request<PropertyDTO>(`/property/${id}/sync-rent-to-income`, { method: "DELETE" }),
  },
  business: {
    list: () => request<BusinessDTO[]>("/business"),
    create: (data: { name: string; description?: string; entityType?: string; currency?: string; startedAt?: string; ownershipPercent?: number }) =>
      request<BusinessDTO>("/business", { method: "POST", body: JSON.stringify(data) }),
    update: (
      id: string,
      data: Partial<{ name: string; description: string; entityType: string; currency: string; startedAt: string; ownershipPercent: number }>,
    ) => request<BusinessDTO>(`/business/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/business/${id}`, { method: "DELETE" }),
    transactions: (businessId: string) => request<BusinessTransactionDTO[]>(`/business/${businessId}/transactions`),
    createTransaction: (
      businessId: string,
      data: { type: string; category?: string; amount: number; occurredAt: string; description?: string; isRecurring?: boolean },
    ) =>
      request<BusinessTransactionDTO>(`/business/${businessId}/transactions`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    updateTransaction: (
      id: string,
      data: Partial<{ type: string; category: string; amount: number; occurredAt: string; description: string; isRecurring: boolean }>,
    ) => request<BusinessTransactionDTO>(`/business/transactions/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    removeTransaction: (id: string) => request<void>(`/business/transactions/${id}`, { method: "DELETE" }),
    // NEW (audit item #9): opt-in owner-drawing -> personal Income sync.
    syncDrawingToIncome: (id: string) =>
      request<{ transactionId: string; income: IncomeDTO }>(`/business/transactions/${id}/sync-to-income`, { method: "POST" }),
    unsyncDrawingFromIncome: (id: string) =>
      request<BusinessTransactionDTO>(`/business/transactions/${id}/sync-to-income`, { method: "DELETE" }),
    obligations: (businessId: string) => request<BusinessObligationDTO[]>(`/business/${businessId}/obligations`),
    createObligation: (
      businessId: string,
      data: { title: string; dueDate: string; amount?: number; recurrence?: string; vendor?: string; status?: string; notes?: string },
    ) =>
      request<BusinessObligationDTO>(`/business/${businessId}/obligations`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    updateObligation: (
      id: string,
      data: Partial<{ title: string; dueDate: string; amount: number; recurrence: string; vendor: string; status: string; notes: string }>,
    ) => request<BusinessObligationDTO>(`/business/obligations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    removeObligation: (id: string) => request<void>(`/business/obligations/${id}`, { method: "DELETE" }),
    summary: (businessId: string, month?: string) =>
      request<BusinessSummaryDTO>(`/business/${businessId}/summary${month ? `?month=${month}` : ""}`),
  },
  documents: {
    list: (category?: string) => request<DocumentDTO[]>(`/documents${category ? `?category=${category}` : ""}`),
    expiring: (withinDays?: number) =>
      request<DocumentDTO[]>(`/documents/expiring${withinDays ? `?withinDays=${withinDays}` : ""}`),
    // Documents linked to one record (e.g. a policy). The server verifies the caller owns it.
    byEntity: (entityType: string, entityId: string) =>
      request<DocumentDTO[]>(`/documents/by-entity?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`),
    discrepancies: () => request<DocumentDiscrepancyDTO[]>("/documents/discrepancies"),
    resolveDiscrepancy: (id: string, resolution: "KEEP_DATABASE" | "DISMISS") =>
      request<{ resolved: boolean }>(`/documents/discrepancies/${id}/resolve`, { method: "POST", body: JSON.stringify({ resolution }) }),
    reconcile: (id: string) => request<{ supported: boolean }>(`/documents/${id}/reconcile`, { method: "POST" }),
    upload: (
      file: File,
      meta: { category: string; tags?: string; expiryDate?: string; entityType?: string; entityId?: string; documentType?: string },
    ) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", meta.category);
      if (meta.tags) formData.append("tags", meta.tags);
      if (meta.expiryDate) formData.append("expiryDate", meta.expiryDate);
      if (meta.entityType && meta.entityId) {
        formData.append("entityType", meta.entityType);
        formData.append("entityId", meta.entityId);
      }
      if (meta.documentType) formData.append("documentType", meta.documentType);
      return requestFormData<DocumentDTO>("/documents", formData);
    },
    update: (id: string, data: { category?: string; tags?: string[]; expiryDate?: string }) =>
      request<DocumentDTO>(`/documents/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/documents/${id}`, { method: "DELETE" }),
    download: (id: string) => downloadFile(`/documents/${id}/download`),
  },
  reports: {
    monthly: (month?: string) => request<MonthlyReportDTO>(`/reports/monthly${month ? `?month=${month}` : ""}`),
    yearly: (financialYear?: string) =>
      request<YearlyReportDTO>(`/reports/yearly${financialYear ? `?financialYear=${financialYear}` : ""}`),
    // Detailed monthly report (money flow, categories, daily spending, deterministic narrative).
    monthlyDetail: (month?: string) => request<MonthlyReportDetailDTO>(`/reports/monthly/detail${qs({ month })}`),
    // January to December for a calendar year, with totals and the category report.
    yearlyMonths: (year?: number | string) => request<YearlyMonthsReportDTO>(`/reports/yearly/months${qs({ year })}`),
    monthlyCsvUrl: (month?: string) => `${API_URL}/reports/monthly/export.csv${month ? `?month=${month}` : ""}`,
    yearlyCsvUrl: (financialYear?: string) =>
      `${API_URL}/reports/yearly/export.csv${financialYear ? `?financialYear=${financialYear}` : ""}`,
  },
  coach: {
    ask: (question: string) => request<CoachInteractionDTO>("/coach/ask", { method: "POST", body: JSON.stringify({ question }) }),
    history: (take?: number) => request<CoachInteractionDTO[]>(`/coach/history${take ? `?take=${take}` : ""}`),
  },
  simulator: {
    run: (scenarioType: ScenarioType, params: Record<string, unknown>) =>
      request<RunScenarioResponseDTO>("/simulator/run", { method: "POST", body: JSON.stringify({ scenarioType, params }) }),
    save: (scenarioType: ScenarioType, params: Record<string, unknown>, label: string) =>
      request<SavedScenarioDTO>("/simulator/save", { method: "POST", body: JSON.stringify({ scenarioType, params, label }) }),
    listSaved: () => request<SavedScenarioDTO[]>("/simulator/saved"),
    removeSaved: (id: string) => request<void>(`/simulator/saved/${id}`, { method: "DELETE" }),
    compare: (ids: string[]) => request<SavedScenarioDTO[]>(`/simulator/compare?ids=${ids.join(",")}`),
  },
  household: {
    get: () => request<HouseholdDTO>("/household"),
    summary: () => request<HouseholdSummaryDTO>("/household/summary"),
    addDependent: (data: { name: string; relation: string; dateOfBirth?: string }) =>
      request<DependentDTO>("/household/dependents", { method: "POST", body: JSON.stringify(data) }),
    removeDependent: (id: string) => request<void>(`/household/dependents/${id}`, { method: "DELETE" }),
  },
  aiSearch: {
    search: (query: string, filters?: AiSearchFiltersDTO) =>
      request<AiSearchResultDTO>("/ai/search", { method: "POST", body: JSON.stringify({ query, ...filters }) }),
    reindex: () => request<{ jobId: string; status: string }>("/ai/search/reindex", { method: "POST" }),
    jobStatus: (jobId: string) => request<AiJobStatusDTO>(`/ai/jobs/${jobId}`),
    history: (take?: number) => request<AiSearchLogDTO[]>(`/ai/search/history${take ? `?take=${take}` : ""}`),
  },
  coach2: {
    ask: (question: string) => request<AgenticCoachResultDTO>("/coach/v2/ask", { method: "POST", body: JSON.stringify({ question }) }),
    history: (take?: number) => request<AgenticCoachRunDTO[]>(`/coach/v2/history${take ? `?take=${take}` : ""}`),
  },
  scenarioStudio: {
    build: (prompt: string, targetGoalIds?: string[]) =>
      request<ScenarioStudioResultDTO>("/scenario-studio/build", { method: "POST", body: JSON.stringify({ prompt, targetGoalIds }) }),
    history: (take?: number) => request<ScenarioStudioRunDTO[]>(`/scenario-studio/history${take ? `?take=${take}` : ""}`),
    // Probabilistic planning: Monte Carlo simulation for a single scenario type +
    // params. `overrides` is any subset of MonteCarloConfigDTO's fields (iterations,
    // horizonYears, seed, or the distribution assumption means/stddevs) — omitted
    // fields fall back to the API's own defaults.
    simulate: (
      scenarioType: string,
      params: Record<string, unknown>,
      overrides?: Partial<Omit<MonteCarloResultDTO["config"], never>>,
    ) =>
      request<{ result: MonteCarloResultDTO; explanation: string; explanationConfidence: number; verificationPassed: boolean }>(
        "/scenario-studio/simulate",
        { method: "POST", body: JSON.stringify({ scenarioType, params, ...overrides }) },
      ),
    // Constraint-solving recommendation — see OptimizationConstraintsDTO for the
    // supported budget/tax/retirement/goal constraint fields.
    optimize: (constraints: OptimizationConstraintsDTO) =>
      request<OptimizedScenarioDTO & { explanation: string; explanationConfidence: number; verificationPassed: boolean }>(
        "/scenario-studio/optimize",
        { method: "POST", body: JSON.stringify(constraints) },
      ),
    simulationHistory: (take?: number) => request<unknown[]>(`/scenario-studio/history/simulations${take ? `?take=${take}` : ""}`),
    optimizationHistory: (take?: number) => request<unknown[]>(`/scenario-studio/history/optimizations${take ? `?take=${take}` : ""}`),
  },
  mlInsights: {
    summary: () => request<MlInsightsSummaryDTO>("/ml-insights/summary"),
  },
  copilotIngestion: {
    createBatch: (sourceLabel: string, rawText: string, defaultPaymentMethod: string) =>
      request<IngestionBatchDTO>("/copilot-ingestion/batches", { method: "POST", body: JSON.stringify({ sourceLabel, rawText, defaultPaymentMethod }) }),
    listBatches: (take?: number) => request<IngestionBatchSummaryDTO[]>(`/copilot-ingestion/batches${take ? `?take=${take}` : ""}`),
    getBatch: (id: string) => request<IngestionBatchDTO>(`/copilot-ingestion/batches/${id}`),
    approve: (itemId: string, input: ApproveReviewItemInput) =>
      request<IngestionReviewItemDTO>(`/copilot-ingestion/items/${itemId}/approve`, { method: "POST", body: JSON.stringify(input) }),
    reject: (itemId: string) => request<IngestionReviewItemDTO>(`/copilot-ingestion/items/${itemId}/reject`, { method: "POST" }),
  },
};

export { ApiError };
