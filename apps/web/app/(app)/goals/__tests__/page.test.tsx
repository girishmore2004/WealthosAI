import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GoalsPage from "../page";
import { api } from "@/lib/api-client";

jest.mock("@/lib/api-client", () => ({
  api: {
    goals: {
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      restore: jest.fn(),
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

describe("GoalsPage overview — planning only, with the money managed in Money → Goals", () => {
  const fundedGoal = { ...baseGoal, id: "g3", name: "Car fund", type: "CAR", currentAmount: "400000", targetAmount: "300000", shortfall: "0.00", hasTargetDate: true, archivedAt: null };

  it("links every goal to its detailed view in Money → Goals (no duplicate management UI here)", async () => {
    mockedApi.goals.list.mockResolvedValue([{ ...baseGoal, shortfall: "150000.00", hasTargetDate: true, archivedAt: null }] as any);
    render(<GoalsPage />);
    await screen.findByText("6-month emergency fund");
    expect(screen.getByRole("link", { name: "Manage funding →" })).toHaveAttribute("href", "/money/goals?goal=g1");
    expect(screen.queryByRole("button", { name: /add money/i })).not.toBeInTheDocument();
  });

  it("shows saved amount and shortfall, and zero shortfall as 'fully funded'", async () => {
    mockedApi.goals.list.mockResolvedValue([{ ...baseGoal, shortfall: "150000.00", hasTargetDate: true, archivedAt: null }, fundedGoal] as any);
    render(<GoalsPage />);
    await screen.findByText("Car fund");
    expect(screen.getAllByText("₹1,50,000", { selector: ".money" }).length).toBeGreaterThan(0);
    expect(screen.getByText("fully funded")).toBeInTheDocument();
  });

  it("a goal without a target date asks for one instead of showing a monthly requirement", async () => {
    mockedApi.goals.list.mockResolvedValue([{ ...baseGoal, shortfall: "150000.00", hasTargetDate: false, archivedAt: null }] as any);
    render(<GoalsPage />);
    expect(await screen.findByText(/Set a target date to see what it would take each month/)).toBeInTheDocument();
    expect(screen.getByText(/no target date/)).toBeInTheDocument();
    expect(screen.queryByText(/to stay on track/)).not.toBeInTheDocument();
  });

  it("the saved amount is not editable here (it is the goal's ledger balance)", async () => {
    mockedApi.goals.list.mockResolvedValue([{ ...baseGoal, shortfall: "150000.00", hasTargetDate: true, archivedAt: null }] as any);
    render(<GoalsPage />);
    await screen.findByText("6-month emergency fund");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByPlaceholderText(/Current amount saved/i)).not.toBeInTheDocument();
  });

  it("offers an opening balance when adding a goal and sends it as the goal's starting entry", async () => {
    mockedApi.goals.list.mockResolvedValue([] as any);
    mockedApi.goals.create.mockResolvedValue({ ...baseGoal, type: "HOUSE" } as any);
    render(<GoalsPage />);
    await screen.findByText("No goals set yet.");
    fireEvent.change(screen.getByPlaceholderText(/Goal name/), { target: { value: "House" } });
    fireEvent.change(screen.getByPlaceholderText("Target amount (₹)"), { target: { value: "2000000" } });
    fireEvent.change(screen.getByPlaceholderText("Already saved (₹, optional)"), { target: { value: "25000" } });
    const date = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: "2030-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    await waitFor(() => expect(mockedApi.goals.create).toHaveBeenCalledWith(expect.objectContaining({ name: "House", targetAmount: 2000000, currentAmount: 25000 })));
  });

  it("does not offer a second emergency fund", async () => {
    mockedApi.goals.list.mockResolvedValue([{ ...baseGoal, shortfall: "150000.00", hasTargetDate: true, archivedAt: null }] as any);
    render(<GoalsPage />);
    await screen.findByText("6-month emergency fund");
    expect(screen.queryByRole("option", { name: "emergency fund" })).not.toBeInTheDocument();
  });

  it("asks before removing, explains what happens to the money, and restores from the closed list", async () => {
    mockedApi.goals.list.mockResolvedValue([{ ...baseGoal, shortfall: "150000.00", hasTargetDate: true, archivedAt: null }, { ...baseGoal, id: "g9", name: "Old trip", archivedAt: "2026-01-01T00:00:00Z" }] as any);
    mockedApi.goals.remove.mockResolvedValue({ id: "g1", archived: true, releasedAmount: "150000.00" } as any);
    mockedApi.goals.restore.mockResolvedValue({} as any);
    render(<GoalsPage />);
    await screen.findByText("6-month emergency fund");
    fireEvent.click(screen.getByRole("button", { name: "Remove goal" }));
    expect(screen.getByText(/returns to your cash; history is kept/)).toBeInTheDocument();
    expect(mockedApi.goals.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mockedApi.goals.remove).toHaveBeenCalledWith("g1"));
    expect(await screen.findByRole("status")).toHaveTextContent("₹1,50,000 returned to your cash");

    fireEvent.click(screen.getByLabelText("Show closed goals"));
    await screen.findByText("Old trip", { exact: false });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(mockedApi.goals.restore).toHaveBeenCalledWith("g9"));
  });
});
