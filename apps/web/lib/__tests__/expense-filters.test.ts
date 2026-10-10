import {
  DEFAULT_FILTERS,
  ExpenseFilterState,
  activeFilterCount,
  filtersToAnalyticsParams,
  filtersToListParams,
  isCustomRangeIncomplete,
  isExpenseTableType,
} from "../expense-filters";

const f = (patch: Partial<ExpenseFilterState> = {}): ExpenseFilterState => ({ ...DEFAULT_FILTERS, ...patch });
const TODAY = "2026-10-04";

describe("expense filters → API params", () => {
  it("defaults to this month, newest first, every kind of expense row", () => {
    expect(filtersToListParams(f(), TODAY, 1, 25)).toEqual({ page: 1, pageSize: 25, period: "THIS_MONTH", today: TODAY, sort: "NEWEST" });
  });

  it("always sends the caller's local today so presets resolve in the user's own day", () => {
    expect(filtersToListParams(f({ period: "YESTERDAY" }), TODAY, 2, 25)).toMatchObject({ period: "YESTERDAY", today: TODAY, page: 2 });
  });

  it("passes category, payment method and sort through", () => {
    expect(filtersToListParams(f({ categoryId: "c1", paymentMethod: "CASH", sort: "HIGHEST" }), TODAY, 1, 25)).toMatchObject({
      categoryId: "c1",
      paymentMethod: "CASH",
      sort: "HIGHEST",
    });
  });

  it("only the two Expense-table types set flowType; ALL leaves it unset", () => {
    expect(filtersToListParams(f({ type: "ALL" }), TODAY, 1, 25).flowType).toBeUndefined();
    expect(filtersToListParams(f({ type: "EXPENSE" }), TODAY, 1, 25).flowType).toBe("EXPENSE");
    expect(filtersToListParams(f({ type: "OTHER_OUTFLOW" }), TODAY, 1, 25).flowType).toBe("OTHER_OUTFLOW");
  });

  it("a custom range sends from/to instead of relying on a preset", () => {
    expect(filtersToListParams(f({ period: "CUSTOM", from: "2026-10-01", to: "2026-10-03" }), TODAY, 1, 25)).toMatchObject({
      period: "CUSTOM",
      from: "2026-10-01",
      to: "2026-10-03",
    });
  });

  it("flags an incomplete custom range so nothing half-specified is requested", () => {
    expect(isCustomRangeIncomplete(f({ period: "CUSTOM" }))).toBe(true);
    expect(isCustomRangeIncomplete(f({ period: "CUSTOM", from: "2026-10-01" }))).toBe(true);
    expect(isCustomRangeIncomplete(f({ period: "CUSTOM", from: "2026-10-01", to: "2026-10-03" }))).toBe(false);
    expect(isCustomRangeIncomplete(f())).toBe(false);
  });

  it("spending analytics default to ordinary EXPENSE rows and never to a ledger that isn't spending", () => {
    expect(filtersToAnalyticsParams(f(), TODAY).flowType).toBe("EXPENSE");
    expect(filtersToAnalyticsParams(f({ type: "EXPENSE" }), TODAY).flowType).toBe("EXPENSE");
    expect(filtersToAnalyticsParams(f({ type: "OTHER_OUTFLOW" }), TODAY).flowType).toBe("OTHER_OUTFLOW");
    expect(filtersToAnalyticsParams(f({ categoryId: "c1" }), TODAY).categoryId).toBe("c1");
  });

  it("only ALL / EXPENSE / OTHER_OUTFLOW live in the Expense table; the rest are other ledgers", () => {
    expect(["ALL", "EXPENSE", "OTHER_OUTFLOW"].every((t) => isExpenseTableType(t as never))).toBe(true);
    expect(["REFUNDABLE", "INVESTMENT", "EMERGENCY", "TRANSFER"].some((t) => isExpenseTableType(t as never))).toBe(false);
  });

  it("counts non-default filters (shown on the mobile Filters button)", () => {
    expect(activeFilterCount(f())).toBe(0);
    expect(activeFilterCount(f({ period: "LAST_MONTH", categoryId: "c1", type: "EXPENSE", paymentMethod: "UPI", sort: "OLDEST" }))).toBe(5);
  });
});
