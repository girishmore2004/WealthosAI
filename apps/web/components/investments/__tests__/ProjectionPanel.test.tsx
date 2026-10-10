import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectionPanel } from "../ProjectionPanel";
import { api } from "@/lib/api-client";
import { portfolioProjection, scenario } from "@/__fixtures__/investments";

jest.mock("@/lib/api-client", () => ({
  api: { investments: { portfolioProjection: jest.fn(), projection: jest.fn() } },
  ApiError: class ApiError extends Error {},
}));

const mocked = api as jest.Mocked<typeof api>;

const whatIf = (over: Record<string, unknown> = {}): any => ({
  basis: "PROJECTED",
  disclaimer: "A projection, not a promise: it assumes the same return every year. Real returns vary and can be negative.",
  assumptions: { currentValue: "0.00", contributionPerPeriod: "10000.00", frequency: "MONTHLY", annualReturnPercent: "12" },
  scenarios: [scenario(5, { totalContributions: "600000.00", principal: "600000.00", projectedValue: "824863.67", projectedGain: "224863.67" }), scenario(10)],
  curve: [{ year: 0, principal: "0.00", projectedValue: "0.00" }],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mocked.investments.portfolioProjection.mockResolvedValue(portfolioProjection());
  mocked.investments.projection.mockResolvedValue(whatIf());
});

describe("ProjectionPanel — my portfolio", () => {
  it("projects the real holdings under a visible 12% assumption, tagged PROJECTED, with the disclaimer", async () => {
    render(<ProjectionPanel />);
    expect(await screen.findByText("10 years")).toBeInTheDocument();
    expect(mocked.investments.portfolioProjection).toHaveBeenCalledWith({ annualReturn: 12 });
    expect(screen.getByText("Currently assuming 12% a year.")).toBeInTheDocument();
    expect(screen.getByText("PROJECTED")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("A projection, not a promise");
  });

  it("spec Part 61: ₹10,000 a month at 12% for 10 years → principal ₹12,00,000, value ₹23,23,391, growth ₹11,23,391", async () => {
    render(<ProjectionPanel />);
    const row = (await screen.findByText("10 years")).closest("tr") as HTMLElement;
    expect(within(row).getByText("₹12,00,000", { selector: "td:nth-of-type(1)" })).toBeInTheDocument();
    expect(within(row).getByText("₹23,23,391")).toBeInTheDocument();
    expect(within(row).getByText("+₹11,23,391")).toBeInTheDocument();
  });

  it("shows what the portfolio is ACTUALLY worth today beside — never inside — the projection", async () => {
    render(<ProjectionPanel />);
    await screen.findByText("10 years");
    expect(screen.getByText(/Worth today \(actual\):/).closest("p")).toHaveTextContent("₹10,500");
  });

  it("changing the assumed return asks the server again — nothing is calculated in the browser", async () => {
    render(<ProjectionPanel />);
    await screen.findByText("10 years");
    mocked.investments.portfolioProjection.mockResolvedValueOnce(portfolioProjection({ scenarios: [scenario(10, { projectedValue: "1700000.00", projectedGain: "500000.00" })] }));
    fireEvent.click(screen.getByRole("button", { name: "8%" }));
    await waitFor(() => expect(mocked.investments.portfolioProjection).toHaveBeenLastCalledWith({ annualReturn: 8 }));
    expect(await screen.findByText("₹17,00,000", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "8%" })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers 8, 10, 12 and 15 and accepts a custom return", async () => {
    render(<ProjectionPanel />);
    await screen.findByText("10 years");
    for (const r of ["8%", "10%", "12%", "15%"]) expect(screen.getByRole("button", { name: r })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Custom return in percent"), { target: { value: "9.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(mocked.investments.portfolioProjection).toHaveBeenLastCalledWith({ annualReturn: 9.5 }));
  });

  it("rejects an out-of-range custom return without calling the server", async () => {
    render(<ProjectionPanel />);
    await screen.findByText("10 years");
    mocked.investments.portfolioProjection.mockClear();
    fireEvent.change(screen.getByLabelText("Custom return in percent"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("between 0 and 100");
    expect(mocked.investments.portfolioProjection).not.toHaveBeenCalled();
  });

  it("says plainly when holdings were left out because no return was assumed for them", async () => {
    mocked.investments.portfolioProjection.mockResolvedValue(portfolioProjection({ excludedCount: 2, includedCount: 1 }));
    render(<ProjectionPanel />);
    expect(await screen.findByText(/2 holdings are not in the projection because no return was assumed/)).toBeInTheDocument();
  });

  it("explains an empty portfolio instead of showing zeros", async () => {
    mocked.investments.portfolioProjection.mockResolvedValue(portfolioProjection({ scenarios: [], curve: [], holdings: [], actual: { basis: "ACTUAL", currentValue: "0.00", holdings: 0 }, includedCount: 0 }));
    render(<ProjectionPanel />);
    expect(await screen.findByText(/Add a holding to see where it could be/)).toBeInTheDocument();
  });

  it("shows an error if the projection cannot be loaded", async () => {
    mocked.investments.portfolioProjection.mockRejectedValue(new Error("down"));
    render(<ProjectionPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the projection.");
  });

  it("reports the assumed rate and projection to the page (for its summary cards)", async () => {
    const onChange = jest.fn();
    render(<ProjectionPanel onChange={onChange} />);
    await screen.findByText("10 years");
    expect(onChange).toHaveBeenCalledWith(12, expect.objectContaining({ basis: "PROJECTED" }));
  });
});

describe("ProjectionPanel — what-if calculator", () => {
  const openWhatIf = async () => {
    render(<ProjectionPanel />);
    await screen.findByText("10 years");
    fireEvent.click(screen.getByRole("tab", { name: "What-if calculator" }));
  };

  it("sends an EXPLICIT return assumption with the amounts, and shows the result", async () => {
    await openWhatIf();
    await waitFor(() => expect(mocked.investments.projection).toHaveBeenCalled());
    expect(mocked.investments.projection).toHaveBeenLastCalledWith({ annualReturn: 12, currentValue: 0, contribution: 10000, frequency: "MONTHLY" });
    expect(await screen.findByText("₹23,23,391")).toBeInTheDocument();
  });

  it("recalculates with the typed amounts and chosen frequency", async () => {
    await openWhatIf();
    await waitFor(() => expect(mocked.investments.projection).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Starting amount (₹)"), { target: { value: "50000" } });
    fireEvent.change(screen.getByLabelText("Added each time (₹)"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("How often"), { target: { value: "WEEKLY" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    await waitFor(() => expect(mocked.investments.projection).toHaveBeenLastCalledWith({ annualReturn: 12, currentValue: 50000, contribution: 1000, frequency: "WEEKLY" }));
  });

  it("offers every contribution frequency, including every 2 weeks", async () => {
    await openWhatIf();
    const select = screen.getByLabelText("How often");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Weekly", "Every 2 weeks", "Monthly", "Quarterly", "Yearly"]);
  });

  it("re-runs when the assumed return changes", async () => {
    await openWhatIf();
    await waitFor(() => expect(mocked.investments.projection).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "15%" }));
    await waitFor(() => expect(mocked.investments.projection).toHaveBeenLastCalledWith(expect.objectContaining({ annualReturn: 15 })));
  });

  it("refuses negative amounts before calling the server", async () => {
    await openWhatIf();
    await waitFor(() => expect(mocked.investments.projection).toHaveBeenCalled());
    mocked.investments.projection.mockClear();
    fireEvent.change(screen.getByLabelText("Added each time (₹)"), { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter amounts of zero or more.");
    expect(mocked.investments.projection).not.toHaveBeenCalled();
  });
});
