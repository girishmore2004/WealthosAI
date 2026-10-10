import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import InvestmentsPage from "../page";
import { api } from "@/lib/api-client";
import { analyticsData, cashflow, holding, metrics, portfolioProjection, schedule } from "@/__fixtures__/investments";

jest.mock("@/lib/api-client", () => ({
  api: {
    investments: {
      list: jest.fn(),
      summary: jest.fn(),
      analytics: jest.fn(),
      portfolioProjection: jest.fn(),
      projection: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      rebalance: jest.fn(),
      metrics: jest.fn(),
      cashflows: jest.fn(),
      valuations: jest.fn(),
      sipSchedule: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));

// Charts need real layout, which jsdom lacks; the data they plot is asserted through the text and API calls.
jest.mock("@/components/investments/InvestmentCharts", () => ({
  ...jest.requireActual("@/components/investments/InvestmentCharts"),
  InvestedVsCurrentChart: () => <div data-testid="invested-chart" />,
  ContributionTrendChart: () => <div data-testid="contrib-chart" />,
  ValueTrendChart: () => <div data-testid="value-chart" />,
  GainTrendChart: () => <div data-testid="gain-chart" />,
}));
jest.mock("@/components/investments/RebalancePanel", () => ({ RebalancePanel: () => <div data-testid="rebalance" /> }));

const inv = api.investments as jest.Mocked<typeof api.investments>;

const summary = { totalCurrentValue: "10500", totalCostBasis: "10000", totalGainLoss: "500", totalGainLossPercent: 5, allocation: [{ type: "MUTUAL_FUND", value: 10500, percent: 100 }] };

beforeEach(() => {
  jest.clearAllMocks();
  inv.list.mockResolvedValue([holding()]);
  inv.summary.mockResolvedValue(summary as any);
  inv.analytics.mockResolvedValue(analyticsData());
  inv.portfolioProjection.mockResolvedValue(portfolioProjection());
  inv.metrics.mockResolvedValue(metrics());
  inv.cashflows.mockResolvedValue([cashflow()]);
  inv.valuations.mockResolvedValue([]);
  inv.sipSchedule.mockResolvedValue(schedule());
});

describe("InvestmentsPage — overview", () => {
  it("separates what is ACTUAL, what is planned (FORECAST) and what is PROJECTED", async () => {
    render(<InvestmentsPage />);
    await screen.findByText("Nifty 50 Index Fund");

    const today = (await screen.findByText("Your portfolio today")).closest("section") as HTMLElement;
    expect(within(today).getAllByText("ACTUAL")).toHaveLength(4);
    expect(within(today).getByText("₹10,000")).toBeInTheDocument(); // total invested
    expect(within(today).getByText("₹10,500")).toBeInTheDocument(); // current value
    expect(within(today).getByText("+₹500")).toBeInTheDocument(); // gain
    expect(within(today).getByText("+5.0%")).toBeInTheDocument(); // return

    const contrib = screen.getByText("Your contributions").closest("section") as HTMLElement;
    expect(within(contrib).getAllByText("FORECAST")).toHaveLength(2); // planned monthly / annual
    expect(within(contrib).getAllByText("ACTUAL")).toHaveLength(2); // recorded this month / year
    expect(within(contrib).getByText("₹14,333")).toBeInTheDocument();
    expect(within(contrib).getByText("₹1,72,000")).toBeInTheDocument();
    expect(within(contrib).getByText("₹3,000")).toBeInTheDocument();
    expect(within(contrib).getByText("₹42,000")).toBeInTheDocument();

    const proj = screen.getByText(/What it could become/, { selector: "h2" }).closest("section") as HTMLElement;
    expect(within(proj).getAllByText("PROJECTED")).toHaveLength(2);
    expect(within(proj).getByText("₹23,23,391")).toBeInTheDocument();
  });

  it("labels a loss as a loss, with a sign", async () => {
    inv.summary.mockResolvedValue({ ...summary, totalCurrentValue: "9000", totalGainLoss: "-1000", totalGainLossPercent: -10 } as any);
    render(<InvestmentsPage />);
    const today = (await screen.findByText("Your portfolio today")).closest("section") as HTMLElement;
    expect(await within(today).findByText("−₹1,000")).toBeInTheDocument();
    expect(within(today).getByText("below what you put in")).toBeInTheDocument();
  });

  it("allocation by type, risk and liquidity comes from the server's analytics", async () => {
    render(<InvestmentsPage />);
    await screen.findByText("By type");
    expect(screen.getByText("By risk")).toBeInTheDocument();
    expect(screen.getByText("By liquidity")).toBeInTheDocument();
    expect(screen.getAllByText("₹10,500 · 100.0%").length).toBe(3);
  });

  it("renders the trend and comparison charts", async () => {
    render(<InvestmentsPage />);
    expect(await screen.findByTestId("invested-chart")).toBeInTheDocument();
    for (const id of ["contrib-chart", "value-chart", "gain-chart"]) expect(await screen.findByTestId(id)).toBeInTheDocument();
  });

  it("says what the gain trend is based on when only some holdings have a ledger", async () => {
    inv.analytics.mockResolvedValue(analyticsData({ overview: { ...analyticsData().overview, holdings: 3, holdingsWithLedger: 1 } }));
    render(<InvestmentsPage />);
    expect(await screen.findByText(/Based on 1 of 3 holdings/)).toBeInTheDocument();
  });

  it("the holdings still load when the supplementary analytics fail", async () => {
    inv.analytics.mockRejectedValue(new Error("down"));
    render(<InvestmentsPage />);
    expect(await screen.findByText("Nifty 50 Index Fund")).toBeInTheDocument();
    expect(await screen.findByText("Allocation is unavailable right now.")).toBeInTheDocument();
  });

  it("shows an error when the holdings cannot be loaded", async () => {
    inv.list.mockRejectedValue(new Error("down"));
    render(<InvestmentsPage />);
    expect(await screen.findByText("Could not load investments.")).toBeInTheDocument();
  });

  it("an empty portfolio says how to start", async () => {
    inv.list.mockResolvedValue([]);
    render(<InvestmentsPage />);
    expect(await screen.findByText(/No holdings logged yet/)).toBeInTheDocument();
  });
});

describe("InvestmentsPage — holdings", () => {
  it("shows each holding with its type, risk, liquidity and what was invested", async () => {
    render(<InvestmentsPage />);
    const row = (await screen.findByText("Nifty 50 Index Fund")).closest("li") as HTMLElement;
    expect(row).toHaveTextContent("mutual fund · moderate risk · liquid");
    expect(row).toHaveTextContent("₹10,500");
    expect(row).toHaveTextContent("invested ₹10,000");
  });

  it("marks a holding that has an active recurring contribution", async () => {
    inv.list.mockResolvedValue([holding({ sipActive: true })]);
    render(<InvestmentsPage />);
    expect(await screen.findByText("Recurring")).toBeInTheDocument();
  });

  it("opens a holding's ledger on demand — and only then asks for its history", async () => {
    render(<InvestmentsPage />);
    await screen.findByText("Nifty 50 Index Fund");
    expect(inv.metrics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show details for Nifty 50 Index Fund" }));
    await waitFor(() => expect(inv.metrics).toHaveBeenCalledWith("h1"));
    expect(await screen.findByRole("tab", { name: "Transactions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide details for Nifty 50 Index Fund" }));
    expect(screen.queryByRole("tab", { name: "Transactions" })).not.toBeInTheDocument();
  });

  it("deleting asks first and warns that the whole history goes with the holding", async () => {
    inv.remove.mockResolvedValue(undefined as any);
    render(<InvestmentsPage />);
    await screen.findByText("Nifty 50 Index Fund");
    fireEvent.click(screen.getByText("Remove"));
    expect(screen.getByText(/everything recorded for it \(transactions, value history, sale records\)/)).toBeInTheDocument();
    expect(inv.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(inv.remove).toHaveBeenCalledWith("h1"));
  });

  it("'Keep' cancels the deletion", async () => {
    render(<InvestmentsPage />);
    await screen.findByText("Nifty 50 Index Fund");
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(inv.remove).not.toHaveBeenCalled();
  });

  it("editing a holding saves the same fields as before", async () => {
    inv.update.mockResolvedValue({} as any);
    render(<InvestmentsPage />);
    await screen.findByText("Nifty 50 Index Fund");
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByPlaceholderText("Current value (₹)"), { target: { value: "11000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(inv.update).toHaveBeenCalledWith("h1", expect.objectContaining({ name: "Nifty 50 Index Fund", currentValue: 11000, costBasis: 10000, riskLevel: "MODERATE", liquidity: "LIQUID" })),
    );
  });
});

describe("InvestmentsPage — adding a holding", () => {
  it("opens a form, saves the holding and refreshes the page without a reload", async () => {
    inv.create.mockResolvedValue(holding({ id: "h2" }));
    render(<InvestmentsPage />);
    await screen.findByText("Nifty 50 Index Fund");
    const before = inv.list.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "+ Add holding" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a holding" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Gold ETF" } });
    fireEvent.change(within(dialog).getByLabelText("Amount invested so far (₹)"), { target: { value: "20000" } });
    fireEvent.change(within(dialog).getByLabelText("Worth now (₹)"), { target: { value: "22000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add holding" }));

    await waitFor(() => expect(inv.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Gold ETF", costBasis: 20000, currentValue: 22000, type: "MUTUAL_FUND", riskLevel: "MODERATE", liquidity: "SEMI_LIQUID", purchaseDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) })));
    await waitFor(() => expect(inv.list.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByRole("status")).toHaveTextContent("Gold ETF added");
  });

  it("requires a name and valid amounts before calling the API", async () => {
    render(<InvestmentsPage />);
    await screen.findByText("Nifty 50 Index Fund");
    fireEvent.click(screen.getByRole("button", { name: "+ Add holding" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a holding" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add holding" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Give this holding a name.");
    expect(inv.create).not.toHaveBeenCalled();
  });

  it("offers all fourteen investment types", async () => {
    render(<InvestmentsPage />);
    await screen.findByText("Nifty 50 Index Fund");
    fireEvent.click(screen.getByRole("button", { name: "+ Add holding" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a holding" });
    expect(within(within(dialog).getByLabelText("Type")).getAllByRole("option")).toHaveLength(14);
  });
});

describe("InvestmentsPage — projection", () => {
  it("asks the server for the portfolio projection under the visible default assumption", async () => {
    render(<InvestmentsPage />);
    await screen.findByText("Nifty 50 Index Fund");
    await waitFor(() => expect(inv.portfolioProjection).toHaveBeenCalledWith({ annualReturn: 12 }));
    expect(screen.getByText("Currently assuming 12% a year.")).toBeInTheDocument();
  });
});
