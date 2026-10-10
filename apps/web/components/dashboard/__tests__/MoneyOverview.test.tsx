import { render, screen, within } from "@testing-library/react";
import type { DashboardOverviewDTO } from "@wealthos/types";
import { MoneyOverview } from "../MoneyOverview";

const overview: DashboardOverviewDTO = {
  basis: "ACTUAL",
  asOfDate: "2026-10-15T10:00:00.000Z",
  month: "2026-10",
  currency: "INR",
  moneyFlow: {
    basis: "ACTUAL",
    period: "MONTHLY",
    asOfDate: "2026-10-15T10:00:00.000Z",
    currency: "INR",
    month: "2026-10",
    income: "65000.00",
    outflows: { expenses: "15000.00", investments: "10000.00", emergencyFund: "7000.00", receivablesGiven: "5000.00", otherOutflow: "0.00" },
    internalTransfers: "3000.00",
    inflows: { receivableRepayments: "0.00", investmentProceeds: "0.00" },
    totalGenuineOutflow: "37000.00",
    netCashFlow: "28000.00",
    percentOfIncome: { expenses: 23.1, investments: 15.4, emergencyFund: 10.8, receivablesGiven: 7.7, otherOutflow: 0 },
    savingsRate: "0.7692",
    investmentRate: "0.1538",
    expenseRate: "0.2308",
    dataHealth: [],
  },
  savingsRate: 76.9,
  investmentRate: 15.4,
  expenseRate: 23.1,
  expenses: {
    today: "500.00",
    month: "15000.00",
    year: "90000.00",
    averagePerDay: "1000.00",
    essential: "9000.00",
    discretionary: "6000.00",
    topCategory: { name: "Housing", total: "9000.00", sharePercent: 60 },
    largest: { id: "e1", amount: "6000.00", spentAt: "2026-10-03T00:00:00.000Z", merchant: "Rent", categoryName: "Housing" },
    highestDay: { date: "2026-10-03", total: "6000.00" },
    comparison: { from: "2026-09-01", to: "2026-09-30", total: "12000.00", change: "3000.00", changePercent: 25 },
  },
  investments: { totalValue: "10000.00", contributedThisMonth: "10000.00", contributedThisYear: "10000.00", plannedMonthlyContribution: "10000.00", activeSchedules: 1, holdings: 1 },
  emergencyFund: { balance: "7000.00", targetAmount: "150000.00", progressPercent: 4.7, coverageMonths: "0.28", contributedThisMonth: "7000.00" },
  receivables: { outstanding: "5000.00", activeCount: 1, dueSoon: { amount: "0.00", count: 0, withinDays: 7 }, overdue: { amount: "0.00", count: 0 } },
  wealth: { netWorth: "52000.00", availableCash: "28000.00", emergencyCash: "7000.00", investments: "10000.00", receivables: "5000.00", property: "0.00", liabilities: "0.00" },
  narrative: ["Your October expenses were ₹15,000, representing 23.1% of your ₹65,000 income."],
  dataHealth: [],
};

describe("MoneyOverview", () => {
  it("shows each flow separately and never lumps them into expenses", () => {
    render(<MoneyOverview overview={overview} />);
    const flow = screen.getByRole("region", { name: /where your money went/i });
    expect(within(flow).getByText("₹65,000")).toBeInTheDocument();
    expect(within(flow).getByText("₹15,000")).toBeInTheDocument();
    expect(within(flow).getByText("₹10,000")).toBeInTheDocument();
    expect(within(flow).getByText("₹7,000")).toBeInTheDocument();
    expect(within(flow).getByText("₹5,000")).toBeInTheDocument();
    expect(screen.queryByText("₹40,000")).not.toBeInTheDocument();
    expect(within(flow).getByText(/₹3,000 moved between your own accounts/)).toBeInTheDocument();
  });

  it("shows the actual savings rate and the deterministic summary", () => {
    render(<MoneyOverview overview={overview} />);
    expect(screen.getByText("76.9%")).toBeInTheDocument();
    expect(screen.getByText(/Your October expenses were ₹15,000, representing 23.1% of your ₹65,000 income\./)).toBeInTheDocument();
  });

  it("shows — (not 0%) when no income was recorded, and a negative savings rate as negative", () => {
    const none = { ...overview, savingsRate: null, investmentRate: null, expenseRate: null, moneyFlow: { ...overview.moneyFlow, percentOfIncome: { expenses: null, investments: null, emergencyFund: null, receivablesGiven: null, otherOutflow: null } } };
    const { unmount } = render(<MoneyOverview overview={none} />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("No income recorded").length).toBe(5);
    unmount();
    render(<MoneyOverview overview={{ ...overview, savingsRate: -50 }} />);
    expect(screen.getByText("-50.0%")).toBeInTheDocument();
  });

  it("links to the detail pages and shows emergency progress with a target", () => {
    render(<MoneyOverview overview={overview} />);
    expect(screen.getByRole("link", { name: "View expense details" })).toHaveAttribute("href", "/money/expenses");
    expect(screen.getByRole("link", { name: "View emergency fund details" })).toHaveAttribute("href", "/money/emergency-fund");
    expect(screen.getByRole("link", { name: "View receivables" })).toHaveAttribute("href", "/money/receivables");
    expect(screen.getByRole("link", { name: "View investment details" })).toHaveAttribute("href", "/money/investments");
    expect(screen.getByRole("progressbar", { name: "Emergency fund progress" })).toHaveAttribute("aria-valuenow", "5");
    expect(screen.getByText(/4\.7% of the ₹1,50,000 target/)).toBeInTheDocument();
    expect(screen.getByText("0.28 months")).toBeInTheDocument();
  });

  it("says when no emergency target is set", () => {
    render(<MoneyOverview overview={{ ...overview, emergencyFund: { ...overview.emergencyFund, targetAmount: null, progressPercent: null } }} />);
    expect(screen.getByText("No target set yet")).toBeInTheDocument();
  });
});
