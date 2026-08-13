import { render, screen } from "@testing-library/react";
import GoalsPage from "../page";
import { api } from "@/lib/api-client";

jest.mock("@/lib/api-client", () => ({
  api: {
    goals: {
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));

const mockedApi = api as jest.Mocked<typeof api>;

const baseGoal = {
  id: "g1",
  userId: "u1",
  type: "EMERGENCY_FUND",
  name: "6-month emergency fund",
  targetAmount: "300000",
  targetDate: "2027-01-01T00:00:00.000Z",
  currentAmount: "150000",
  monthlyContribution: "10000",
  linkedInvestmentValue: "0",
  requiredMonthlyContribution: 12500,
  progressPercent: 50,
  probabilityOfSuccess: "AT_RISK",
  contributionPaceRatio: 0.8,
  isPaceHeuristic: true,
  projectedInvestmentValueAtTarget: "0",
  assumedAnnualReturnPercent: "0",
};

describe("GoalsPage pace-heuristic disclosure (new, audit item #12)", () => {
  it("shows the contribution pace ratio as a percentage, framed as a comparison rather than a probability", async () => {
    mockedApi.goals.list.mockResolvedValue([baseGoal] as any);

    render(<GoalsPage />);

    await screen.findByText("6-month emergency fund");

    expect(await screen.findByText(/Contributing at 80% of the pace needed/i)).toBeInTheDocument();
    expect(screen.getByText(/not a modeled probability of success/i)).toBeInTheDocument();
  });

  it("still shows the existing on-track/at-risk/off-track badge label (unchanged wording)", async () => {
    mockedApi.goals.list.mockResolvedValue([baseGoal] as any);

    render(<GoalsPage />);
    await screen.findByText("6-month emergency fund");

    expect(screen.getByText("At risk")).toBeInTheDocument();
  });

  it("rounds the pace ratio correctly for a fully-funded goal (ratio > 1)", async () => {
    mockedApi.goals.list.mockResolvedValue([
      { ...baseGoal, id: "g2", name: "Overfunded goal", probabilityOfSuccess: "ON_TRACK", contributionPaceRatio: 1.25 },
    ] as any);

    render(<GoalsPage />);
    await screen.findByText("Overfunded goal");

    expect(await screen.findByText(/Contributing at 125% of the pace needed/i)).toBeInTheDocument();
  });
});
