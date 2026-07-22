import type {
  DashboardSummaryDTO,
  ExpenseDTO,
  CategoryBreakdownDTO,
  DetectedSubscriptionDTO,
  IncomeDTO,
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
  ScenarioStudioResultDTO,
  ScenarioStudioRunDTO,
  MlInsightsSummaryDTO,
  IngestionBatchDTO,
  IngestionBatchSummaryDTO,
  IngestionReviewItemDTO,
  ApproveReviewItemInput,
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
  },
  income: {
    list: () => request<IncomeDTO[]>("/income"),
    create: (data: Partial<IncomeDTO> & { source: string; label: string; amount: number; recurrence: string; receivedAt: string }) =>
      request<IncomeDTO>("/income", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/income/${id}`, { method: "DELETE" }),
    update: (id: string, data: Partial<{ source: string; label: string; amount: number; recurrence: string; receivedAt: string; notes: string }>) =>
      request<IncomeDTO>(`/income/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  },
  expenses: {
    list: (month?: string) => request<ExpenseDTO[]>(`/expenses${month ? `?month=${month}` : ""}`),
    categories: () => request<CategoryDTO[]>("/categories"),
    create: (data: {
      categoryId: string;
      merchant?: string;
      amount: number;
      spentAt: string;
      paymentMethod: string;
      notes?: string;
    }) => request<ExpenseDTO>("/expenses", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/expenses/${id}`, { method: "DELETE" }),
    update: (id: string, data: Partial<{ categoryId: string; merchant: string; amount: number; spentAt: string; paymentMethod: string; notes: string }>) =>
      request<ExpenseDTO>(`/expenses/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    subscriptions: () => request<DetectedSubscriptionDTO[]>("/expenses/subscriptions"),
    breakdown: (month?: string) =>
      request<CategoryBreakdownDTO[]>(`/expenses/breakdown${month ? `?month=${month}` : ""}`),
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
  },
  loans: {
    list: () => request<LoanDTO[]>("/loans"),
    summary: () => request<DebtSummaryDTO>("/loans/summary"),
    create: (data: {
      type: string;
      lender: string;
      principal: number;
      outstandingPrincipal: number;
      interestRateAnnual: number;
      tenureMonths: number;
      emiAmount: number;
      startDate: string;
    }) => request<LoanDTO>("/loans", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/loans/${id}`, { method: "DELETE" }),
    update: (id: string, data: Partial<{ type: string; lender: string; principal: number; outstandingPrincipal: number; interestRateAnnual: number; tenureMonths: number; emiAmount: number; startDate: string; notes: string }>) =>
      request<LoanDTO>(`/loans/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    prepaymentImpact: (id: string, lumpSum: number) =>
      request<{ monthsSaved: number; interestSaved: number; originalTenureMonths: number; newTenureMonths: number }>(
        `/loans/${id}/prepayment-impact?lumpSum=${lumpSum}`,
      ),
  },
  insurance: {
    list: () => request<InsurancePolicyDTO[]>("/insurance"),
    gapAnalysis: () => request<CoverageGapDTO[]>("/insurance/gap-analysis"),
    renewals: (withinDays?: number) =>
      request<InsurancePolicyDTO[]>(`/insurance/renewals${withinDays ? `?withinDays=${withinDays}` : ""}`),
    nomineeSummary: () =>
      request<{ policyId: string; type: string; provider: string; nomineeName: string | null }[]>(
        "/insurance/nominee-summary",
      ),
    create: (data: {
      type: string;
      provider: string;
      policyNumber?: string;
      premiumAmount: number;
      premiumFrequency: string;
      coverageAmount: number;
      renewalDate: string;
      nomineeName?: string;
    }) => request<InsurancePolicyDTO>("/insurance", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/insurance/${id}`, { method: "DELETE" }),
    update: (id: string, data: Partial<{ type: string; provider: string; policyNumber: string; premiumAmount: number; premiumFrequency: string; coverageAmount: number; renewalDate: string; nomineeName: string; notes: string }>) =>
      request<InsurancePolicyDTO>(`/insurance/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
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
    }) => request<GoalDTO>("/goals", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: string) => request<void>(`/goals/${id}`, { method: "DELETE" }),
    update: (id: string, data: Partial<{ type: string; name: string; targetAmount: number; targetDate: string; currentAmount: number; monthlyContribution: number }>) =>
      request<GoalDTO>(`/goals/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  },
  tax: {
    deductions: (financialYear?: string) =>
      request<TaxDeductionDTO[]>(`/tax/deductions${financialYear ? `?financialYear=${financialYear}` : ""}`),
    addDeduction: (data: { section: string; description: string; amount: number; financialYear: string }) =>
      request<TaxDeductionDTO>("/tax/deductions", { method: "POST", body: JSON.stringify(data) }),
    removeDeduction: (id: string) => request<void>(`/tax/deductions/${id}`, { method: "DELETE" }),
    estimate: (financialYear?: string) =>
      request<TaxEstimateDTO>(`/tax/estimate${financialYear ? `?financialYear=${financialYear}` : ""}`),
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
    upload: (file: File, meta: { category: string; tags?: string; expiryDate?: string }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", meta.category);
      if (meta.tags) formData.append("tags", meta.tags);
      if (meta.expiryDate) formData.append("expiryDate", meta.expiryDate);
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
    monthlyCsvUrl: (month?: string) => `${API_URL}/reports/monthly/export.csv${month ? `?month=${month}` : ""}`,
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
