import type { ExpenseFlowType } from "@wealthos/types";
import type { ExpenseAnalyticsParams, ExpenseListParams, ExpensePeriodName, ExpenseSortName } from "@/lib/api-client";

// The Type filter covers every kind of money movement. Only the first three live in the Expense
// table; the rest are separate ledgers (receivables, investments, emergency fund, transfers) and
// are shown from THEIR endpoints, never faked as expenses.
export type ExpenseTypeFilter = "ALL" | "EXPENSE" | "OTHER_OUTFLOW" | "REFUNDABLE" | "INVESTMENT" | "EMERGENCY" | "TRANSFER";

export interface ExpenseFilterState {
  period: ExpensePeriodName;
  from: string;
  to: string;
  categoryId: string; // "" = all
  type: ExpenseTypeFilter;
  paymentMethod: string; // "" = all
  sort: ExpenseSortName;
}

export const DEFAULT_FILTERS: ExpenseFilterState = {
  period: "THIS_MONTH",
  from: "",
  to: "",
  categoryId: "",
  type: "ALL",
  paymentMethod: "",
  sort: "NEWEST",
};

export const PERIOD_OPTIONS: Array<{ value: ExpensePeriodName; label: string }> = [
  { value: "TODAY", label: "Today" },
  { value: "YESTERDAY", label: "Yesterday" },
  { value: "THIS_WEEK", label: "This week" },
  { value: "LAST_WEEK", label: "Last week" },
  { value: "THIS_MONTH", label: "This month" },
  { value: "LAST_MONTH", label: "Last month" },
  { value: "THIS_YEAR", label: "This year" },
  { value: "LAST_YEAR", label: "Last year" },
  { value: "CUSTOM", label: "Custom range" },
];

export const TYPE_OPTIONS: Array<{ value: ExpenseTypeFilter; label: string }> = [
  { value: "ALL", label: "All spending" },
  { value: "EXPENSE", label: "Non-refundable expense" },
  { value: "OTHER_OUTFLOW", label: "Other outflow" },
  { value: "REFUNDABLE", label: "Refundable (money given)" },
  { value: "INVESTMENT", label: "Investment" },
  { value: "EMERGENCY", label: "Emergency fund" },
  { value: "TRANSFER", label: "Internal transfer" },
];

export const PAYMENT_METHOD_OPTIONS = [
  { value: "UPI", label: "UPI" },
  { value: "CARD", label: "Card" },
  { value: "CASH", label: "Cash" },
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "WALLET", label: "Wallet" },
  { value: "OTHER", label: "Other" },
];

export const SORT_OPTIONS: Array<{ value: ExpenseSortName; label: string }> = [
  { value: "NEWEST", label: "Newest" },
  { value: "OLDEST", label: "Oldest" },
  { value: "HIGHEST", label: "Highest" },
  { value: "LOWEST", label: "Lowest" },
];

/** True when this Type is stored as Expense rows (so the transaction table + analytics apply). */
export const isExpenseTableType = (t: ExpenseTypeFilter): boolean => t === "ALL" || t === "EXPENSE" || t === "OTHER_OUTFLOW";

/** A CUSTOM period needs both dates; until then the filter is incomplete and nothing is requested. */
export const isCustomRangeIncomplete = (f: ExpenseFilterState): boolean => f.period === "CUSTOM" && (!f.from || !f.to);

/** How many filters differ from the defaults — shown on the mobile "Filters" button. */
export function activeFilterCount(f: ExpenseFilterState): number {
  return (
    (f.period !== DEFAULT_FILTERS.period ? 1 : 0) +
    (f.categoryId ? 1 : 0) +
    (f.type !== DEFAULT_FILTERS.type ? 1 : 0) +
    (f.paymentMethod ? 1 : 0) +
    (f.sort !== DEFAULT_FILTERS.sort ? 1 : 0)
  );
}

const periodParams = (f: ExpenseFilterState, today: string) =>
  f.period === "CUSTOM" ? { period: "CUSTOM" as const, from: f.from, to: f.to, today } : { period: f.period, today };

/** Transaction-table query. `ALL` leaves flowType unset so every kind of expense row is listed. */
export function filtersToListParams(f: ExpenseFilterState, today: string, page: number, pageSize: number): ExpenseListParams {
  const flowType: ExpenseFlowType | undefined = f.type === "EXPENSE" || f.type === "OTHER_OUTFLOW" ? f.type : undefined;
  return {
    page,
    pageSize,
    ...periodParams(f, today),
    ...(f.categoryId ? { categoryId: f.categoryId } : {}),
    ...(flowType ? { flowType } : {}),
    ...(f.paymentMethod ? { paymentMethod: f.paymentMethod } : {}),
    sort: f.sort,
  };
}

/** Analytics query. Spending analytics default to ordinary expenses; OTHER_OUTFLOW only when chosen. */
export function filtersToAnalyticsParams(f: ExpenseFilterState, today: string): ExpenseAnalyticsParams {
  return {
    ...periodParams(f, today),
    ...(f.categoryId ? { categoryId: f.categoryId } : {}),
    flowType: f.type === "OTHER_OUTFLOW" ? "OTHER_OUTFLOW" : "EXPENSE",
  };
}

export const periodLabel = (p: ExpensePeriodName): string => PERIOD_OPTIONS.find((o) => o.value === p)?.label ?? p;
