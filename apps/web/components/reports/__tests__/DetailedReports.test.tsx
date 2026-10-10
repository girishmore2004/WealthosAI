import { render, screen, waitFor } from "@testing-library/react";
import type { MonthlyReportDetailDTO, YearlyMonthsReportDTO } from "@wealthos/types";
import { MonthlyDetailReport, YearByMonthReport } from "../DetailedReports";

const monthlyDetail = jest.fn();
const yearlyMonths = jest.fn();
jest.mock("@/lib/api-client", () => ({
  api: { reports: { monthlyDetail: (...a: unknown[]) => monthlyDetail(...a), yearlyMonths: (...a: unknown[]) => yearlyMonths(...a) } },
  ApiError: class ApiError extends Error {},
}));

const flow = {
  basis: "ACTUAL", period: "MONTHLY", asOfDate: "x", currency: "INR", month: "2026-10", income: "65000.00",
  outflows: { expenses: "15000.00", investments: "10000.00", emergencyFund: "7000.00", receivablesGiven: "5000.00", otherOutflow: "0.00" },
  internalTransfers: "3000.00", inflows: { receivableRepayments: "0.00", investmentProceeds: "0.00" }, totalGenuineOutflow: "37000.00", netCashFlow: "28000.00",
  percentOfIncome: { expenses: 23.1, investments: 15.4, emergencyFund: 10.8, receivablesGiven: 7.7, otherOutflow: 0 }, savingsRate: "0.7692", investmentRate: "0.1538", expenseRate: "0.2308", dataHealth: [],
};

const detail: MonthlyReportDetailDTO = {
  basis: "ACTUAL", month: "2026-10", currency: "INR", moneyFlow: flow as never,
  income: "65000.00", expenses: "15000.00", investments: "10000.00", emergencyFund: "7000.00", receivablesGiven: "5000.00", receivableRepayments: "0.00",
  otherOutflow: "0.00", internalTransfers: "3000.00", netCashFlow: "28000.00", savingsRate: 76.9, investmentRate: 15.4, expenseRate: 23.1,
  netWorthChange: { basis: "ESTIMATED", amount: "50000.00", note: "Income minus expenses and other outflows." },
  categories: [{ categoryId: "c1", category: "Housing", type: "NEED", amount: "9000.00", percentOfTotal: 60, previousAmount: "7500.00", changePercent: 20 }],
  topCategories: [],
  dailySpending: [{ date: "2026-10-03", total: "6000.00", count: 1 }],
  averagePerDay: "1000.00", highestDay: { date: "2026-10-03", total: "6000.00" },
  recurringVsOneTime: { recurring: "6000.00", oneTime: "9000.00", recurringPercent: 40 },
  largestTransactions: [{ id: "e1", amount: "6000.00", spentAt: "2026-10-03T00:00:00.000Z", merchant: "Rent", categoryName: "Housing" }],
  comparison: { from: "2026-09-01", to: "2026-09-30", total: "12000.00", change: "3000.00", changePercent: 25 },
  narrative: ["Your October expenses were ₹15,000, representing 23.1% of your ₹65,000 income."],
  dataHealth: [],
};

describe("MonthlyDetailReport", () => {
  beforeEach(() => monthlyDetail.mockReset());

  it("renders the narrative, the flows and the category change", async () => {
    monthlyDetail.mockResolvedValue(detail);
    render(<MonthlyDetailReport />);
    expect(await screen.findByText(/Your October expenses were ₹15,000, representing 23\.1%/)).toBeInTheDocument();
    expect(screen.getByText("Money lent")).toBeInTheDocument();
    expect(screen.getByText(/₹3,000 moved between your own accounts/)).toBeInTheDocument();
    expect(screen.getByText("+20.0%")).toBeInTheDocument();
    expect(screen.getByText("ESTIMATED")).toBeInTheDocument();
    expect(screen.getByText(/Rent · 3 Oct 2026/)).toBeInTheDocument();
  });

  it("shows the API's error message", async () => {
    monthlyDetail.mockRejectedValue(new Error("boom"));
    render(<MonthlyDetailReport />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not load the report/i));
  });
});

describe("YearByMonthReport", () => {
  beforeEach(() => yearlyMonths.mockReset());

  it("shows January to December with a total row", async () => {
    const months = Array.from({ length: 12 }, (_, i) => ({
      month: `2026-${String(i + 1).padStart(2, "0")}`, income: i < 10 ? "65000.00" : "0.00", expenses: i < 10 ? "15000.00" : "0.00", investments: "0.00",
      emergencyFund: "0.00", receivablesGiven: "0.00", otherOutflow: "0.00", netCashFlow: "0.00", savingsRate: i < 10 ? 76.9 : null,
    }));
    const y: YearlyMonthsReportDTO = {
      basis: "ACTUAL", year: 2026, currency: "INR", months,
      totals: { income: "650000.00", expenses: "150000.00", investments: "0.00", emergencyFund: "0.00", receivablesGiven: "0.00", otherOutflow: "0.00", netCashFlow: "500000.00", savingsRate: 76.9 },
      categories: [], comparison: { from: "2025-01-01", to: "2025-12-31", total: "0.00", change: "0.00", changePercent: null },
      highestExpenseMonth: null, lowestExpenseMonth: null, narrative: ["In 2026 you recorded ₹6,50,000 of income and ₹1,50,000 of expenses across 10 months with activity."],
    };
    yearlyMonths.mockResolvedValue(y);
    render(<YearByMonthReport />);
    expect(await screen.findByText(/In 2026 you recorded ₹6,50,000/)).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Jan 2026" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Dec 2026" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Total" })).toBeInTheDocument();
    expect(screen.getByText("No spending recorded in this period.")).toBeInTheDocument();
  });
});
