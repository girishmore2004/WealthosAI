import { formatPercent, formatRupees, monthName, monthlyNarrative, yearlyNarrative } from "../src/common/financial-facts/financial-narrative";

describe("financial narrative (deterministic text, no model)", () => {
  it("formats rupees with Indian grouping and drops .00", () => {
    expect(formatRupees("15420.00")).toBe("₹15,420");
    expect(formatRupees("1542000")).toBe("₹15,42,000");
    expect(formatRupees("123456789.5")).toBe("₹12,34,56,789.50");
    expect(formatRupees(0)).toBe("₹0");
    expect(formatRupees("-2500")).toBe("-₹2,500");
    expect(formatRupees(null)).toBe("₹0");
  });

  it("formats percentages to one decimal and trims a trailing .0", () => {
    expect(formatPercent(23.74)).toBe("23.7%");
    expect(formatPercent(25)).toBe("25%");
    expect(formatPercent(-3.04)).toBe("-3%");
  });

  it("names months", () => {
    expect(monthName("2026-10")).toBe("October");
    expect(monthName("nonsense")).toBe("nonsense");
  });

  const base = {
    month: "2026-10",
    income: "65000.00",
    expenses: "15420.00",
    investments: "0.00",
    emergencyFund: "0.00",
    receivablesGiven: "0.00",
    receivableRepayments: "0.00",
    otherOutflow: "0.00",
    internalTransfers: "0.00",
    netCashFlow: "49580.00",
    expenseRate: 23.7,
    investmentRate: 0,
    savingsRate: 76.3,
  };

  it("reproduces the spec's example sentence exactly", () => {
    expect(monthlyNarrative(base)[0]).toBe("Your October expenses were ₹15,420, representing 23.7% of your ₹65,000 income.");
  });

  it("leaves out flows that are zero and never invents a percentage without income", () => {
    const lines = monthlyNarrative({ ...base, income: "0.00", expenseRate: null, savingsRate: null, investmentRate: null, netCashFlow: "-15420.00" });
    expect(lines[0]).toBe("Your October expenses were ₹15,420. No income was recorded for October, so no percentage of income is shown.");
    expect(lines.join(" ")).not.toMatch(/%/);
    expect(lines.join(" ")).toContain("more money went out than came in");
    expect(lines.join(" ")).not.toContain("invested");
  });

  it("describes a negative savings rate honestly", () => {
    const lines = monthlyNarrative({ ...base, income: "10000.00", expenses: "15000.00", expenseRate: 150, savingsRate: -50, netCashFlow: "-5000.00" });
    expect(lines.join(" ")).toContain("Your savings rate was -50% because expenses were higher than income.");
  });

  it("says spending went down as well as up", () => {
    const down = monthlyNarrative({ ...base, comparison: { label: "September", changePercent: -12.5 } }).join(" ");
    expect(down).toContain("Spending was 12.5% lower than September.");
    const none = monthlyNarrative({ ...base, comparison: { label: "September", changePercent: null } }).join(" ");
    expect(none).not.toContain("September");
  });

  it("yearly narrative covers totals, the highest and lowest months and says so when there is no data", () => {
    const lines = yearlyNarrative({
      year: 2026,
      income: "650000.00",
      expenses: "150000.00",
      investments: "100000.00",
      netCashFlow: "280000.00",
      savingsRate: 76.9,
      highestExpenseMonth: { month: "2026-03", total: "21000.00" },
      lowestExpenseMonth: { month: "2026-06", total: "9000.00" },
      monthsWithData: 10,
      comparison: { changePercent: 8 },
      topCategory: { name: "Housing", amount: "90000.00" },
    });
    expect(lines[0]).toBe("In 2026 you recorded ₹6,50,000 of income and ₹1,50,000 of expenses across 10 months with activity.");
    expect(lines.join(" ")).toContain("March was your highest-spending month at ₹21,000.");
    expect(lines.join(" ")).toContain("June was your lowest-spending month at ₹9,000.");
    expect(lines.join(" ")).toContain("Spending was 8% higher than 2025.");
    expect(yearlyNarrative({ ...{ year: 2027, income: 0, expenses: 0, investments: 0, netCashFlow: 0, savingsRate: null, highestExpenseMonth: null, lowestExpenseMonth: null }, monthsWithData: 0 })).toEqual([
      "No income or spending has been recorded for 2027 yet.",
    ]);
  });
});
