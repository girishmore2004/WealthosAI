import { render, screen } from "@testing-library/react";
import { NetWorthCard } from "../NetWorthCard";
import type { DashboardSummaryDTO } from "@wealthos/types";

const baseSummary: DashboardSummaryDTO = {
  netWorth: "500000.00",
  cashBalance: "80000.00",
  monthlyIncome: "100000.00",
  monthlyExpenses: "20000.00",
  savingsRate: 80,
  healthScore: {
    score: 75,
    breakdown: { savingsRate: 80, debtToIncome: 90, emergencyFundMonths: 60, budgetAdherence: 100 },
    band: "STABLE",
    generatedAt: new Date().toISOString(),
    budgetAdherenceIsReal: true,
  },
  insights: [],
  investmentsValue: "300000.00",
  totalDebt: "150000.00",
  propertyValue: "0.00",
  unreadAlertCount: 0,
  uncommittedCash: "65000.00",
  emergencyFundBasis: "GOAL",
  emergencyFundAmount: "60000.00",
};

describe("NetWorthCard", () => {
  it("renders the uncommitted cash row alongside cash balance", () => {
    render(<NetWorthCard summary={baseSummary} />);

    expect(screen.getByText("Cash balance")).toBeInTheDocument();
    expect(screen.getByText("Uncommitted cash")).toBeInTheDocument();
  });

  it("does not show a disclosure footnote when the emergency fund basis is GOAL", () => {
    render(<NetWorthCard summary={baseSummary} />);

    expect(screen.queryByText(/expense logged under an/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Set up an Emergency Fund goal/i)).not.toBeInTheDocument();
  });

  it("shows a legacy-basis disclosure when falling back to the category-name match", () => {
    render(<NetWorthCard summary={{ ...baseSummary, emergencyFundBasis: "CATEGORY_LEGACY" }} />);

    expect(screen.getByText(/expense logged under an/i)).toBeInTheDocument();
  });

  it("shows a no-data disclosure when there is no emergency fund signal at all", () => {
    render(<NetWorthCard summary={{ ...baseSummary, emergencyFundBasis: "NONE", emergencyFundAmount: "0.00" }} />);

    expect(screen.getByText(/Set up an Emergency Fund goal/i)).toBeInTheDocument();
  });
});
