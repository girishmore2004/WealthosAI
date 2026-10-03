import {
  ExpenseRow,
  detectDuplicateRecurringEvents,
  detectDuplicateSalary,
  detectExpenseDuplicates,
  detectInsuranceIssues,
  detectInvestmentIssues,
  detectLegacySavingsExpenses,
  detectNegativeCash,
} from "../src/financial-core/data-health/data-health.detectors";

const e = (o: Partial<ExpenseRow> & { id: string }): ExpenseRow => ({
  amount: "100.00", spentAt: new Date("2026-09-10T00:00:00Z"), merchant: null, categoryName: "Food", categoryType: "NEED",
  sourceType: null, sourceId: null, sourceReference: null, migrated: false, ...o,
});

describe("data health detectors", () => {
  it("flags the same salary recorded twice in a month", () => {
    const i = (id: string) => ({ id, source: "SALARY", amount: "65000.00", receivedAt: new Date("2026-09-01T00:00:00Z"), generatedFromRecurringId: null });
    const [r] = detectDuplicateSalary([i("a"), i("b")]);
    expect(r.code).toBe("DUPLICATE_SALARY");
    expect(r.entityIds).toEqual(["a", "b"]);
  });

  it("does not flag one salary per month", () => {
    const i = (id: string, d: string) => ({ id, source: "SALARY", amount: "65000.00", receivedAt: new Date(d), generatedFromRecurringId: null });
    expect(detectDuplicateSalary([i("a", "2026-09-01T00:00:00Z"), i("b", "2026-10-01T00:00:00Z")])).toEqual([]);
  });

  it("flags a recurring template that produced two rows in one period", () => {
    const i = (id: string) => ({ id, source: "SALARY", amount: "1.00", receivedAt: new Date("2026-09-01T00:00:00Z"), generatedFromRecurringId: "t1" });
    expect(detectDuplicateRecurringEvents([i("a"), i("b")])[0].code).toBe("DUPLICATE_RECURRING_EVENT");
  });

  it("flags exact expense duplicates, and ignores merchant-less rows", () => {
    expect(detectExpenseDuplicates([e({ id: "1", merchant: "Zomato" }), e({ id: "2", merchant: "Zomato" })])[0].code).toBe("DUPLICATE_EXPENSE");
    expect(detectExpenseDuplicates([e({ id: "1" }), e({ id: "2" })])).toEqual([]);
  });

  it("flags near-duplicates one day apart as a possible bank duplicate", () => {
    const out = detectExpenseDuplicates([
      e({ id: "1", merchant: "Swiggy", spentAt: new Date("2026-09-10T00:00:00Z") }),
      e({ id: "2", merchant: "Swiggy", spentAt: new Date("2026-09-11T00:00:00Z") }),
    ]);
    expect(out.map((x) => x.code)).toEqual(["POSSIBLE_BANK_DUPLICATE"]);
  });

  it("detects a SIP recorded as BOTH an expense and a contribution (spec example)", () => {
    const [r] = detectLegacySavingsExpenses(
      [e({ id: "x", amount: "10000.00", categoryName: "SIP", categoryType: "SAVINGS" })],
      [{ id: "c1", investmentId: "i1", amount: "10000.00", occurredAt: new Date("2026-09-05T00:00:00Z") }],
    );
    expect(r.code).toBe("INVESTMENT_AS_EXPENSE");
    expect(r.message).toMatch(/Possible duplicate SIP/);
    expect(r.amount).toBe("10000.00");
  });

  it("separates emergency-as-expense, and ignores already-migrated rows", () => {
    const rows = [
      e({ id: "a", categoryName: "Emergency Fund", categoryType: "SAVINGS" }),
      e({ id: "b", categoryName: "SIP", categoryType: "SAVINGS", migrated: true }),
    ];
    expect(detectLegacySavingsExpenses(rows, []).map((x) => x.code)).toEqual(["EMERGENCY_AS_EXPENSE"]);
  });

  it("flags unlinked insurance expenses and a manual premium duplicating a linked one", () => {
    const linked = e({ id: "l", amount: "8500.00", categoryName: "Insurance Premium", sourceType: "INSURANCE_PREMIUM", sourceId: "p1", sourceReference: "2026-09" });
    const manual = e({ id: "m", amount: "8500.00", categoryName: "Insurance Premium" });
    const codes = detectInsuranceIssues([linked, manual], [{ id: "p1", premiumAmount: "8500.00" }]).map((x) => x.code);
    expect(codes).toEqual(["MISSING_SOURCE_REFERENCE", "DUPLICATE_INSURANCE_PREMIUM"]);
  });

  it("flags stale/missing valuations and inconsistent cost basis", () => {
    const now = new Date("2026-10-03T00:00:00Z");
    const codes = detectInvestmentIssues(
      [
        { id: "a", name: "A", costBasis: "100.00", latestValuationAt: null, netCostFromCashflows: null },
        { id: "b", name: "B", costBasis: "100.00", latestValuationAt: new Date("2026-01-01T00:00:00Z"), netCostFromCashflows: "150.00" },
      ],
      now,
    ).map((x) => x.code);
    expect(codes).toEqual(["MISSING_INVESTMENT_VALUATION", "STALE_INVESTMENT_VALUATION", "INCONSISTENT_COST_BASIS"]);
  });

  it("flags negative available cash only when it is negative", () => {
    expect(detectNegativeCash("-1.00")[0].code).toBe("NEGATIVE_AVAILABLE_CASH");
    expect(detectNegativeCash("33000.00")).toEqual([]);
  });
});
