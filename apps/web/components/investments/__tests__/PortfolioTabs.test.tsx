import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SipManager } from "../SipManager";
import { TransactionsPanel } from "../TransactionsPanel";
import { api } from "@/lib/api-client";
import { portfolioHolding } from "@/__fixtures__/investments";

jest.mock("@/lib/api-client", () => ({
  api: {
    investments: {
      pauseSip: jest.fn(),
      resumeSip: jest.fn(),
      cancelSip: jest.fn(),
      sipInstallments: jest.fn(),
      sipChanges: jest.fn(),
      recordInstallment: jest.fn(),
      transactions: jest.fn(),
      updateCashflow: jest.fn(),
      removeCashflow: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));
const inv = api.investments as jest.Mocked<typeof api.investments>;

beforeEach(() => {
  jest.clearAllMocks();
  inv.sipInstallments.mockResolvedValue([]);
  inv.sipChanges.mockResolvedValue([]);
});

describe("SipManager", () => {
  const holdings = [
    portfolioHolding({ id: "a", name: "Active fund", sipStatus: "ACTIVE", plannedMonthly: "5000.00", contributedThisMonth: "5000.00" }),
    portfolioHolding({ id: "p", name: "Paused fund", sipStatus: "PAUSED" }),
    portfolioHolding({ id: "c", name: "Cancelled fund", sipStatus: "CANCELLED" }),
    portfolioHolding({ id: "o", name: "One-time stock", sipStatus: "NONE" }),
  ];

  it("lists only holdings that have a schedule, active first, each with its status", () => {
    render(<SipManager holdings={holdings} onChanged={jest.fn()} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Active fund");
    expect(rows[0]).toHaveTextContent("Active");
    expect(rows[0]).toHaveTextContent("Plans ₹5,000 a month");
    expect(rows[1]).toHaveTextContent("Paused fund");
    expect(screen.queryByText("One-time stock")).not.toBeInTheDocument();
  });

  it("offers Pause on an active SIP and Resume on a paused one, and nothing on a cancelled one", () => {
    render(<SipManager holdings={holdings} onChanged={jest.fn()} />);
    const [active, paused, cancelled] = screen.getAllByRole("listitem");
    expect(within(active).getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(within(paused).getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(within(cancelled).queryByRole("button", { name: /Pause|Resume|Cancel schedule/ })).not.toBeInTheDocument();
  });

  it("pauses through the API and tells the page", async () => {
    inv.pauseSip.mockResolvedValue({} as any);
    const onChanged = jest.fn();
    render(<SipManager holdings={holdings} onChanged={onChanged} />);
    fireEvent.click(within(screen.getAllByRole("listitem")[0]).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(inv.pauseSip).toHaveBeenCalledWith("a"));
    expect(onChanged).toHaveBeenCalledWith(expect.stringContaining("paused"));
  });

  it("an empty set says how to start", () => {
    render(<SipManager holdings={[holdings[3]]} onChanged={jest.fn()} />);
    expect(screen.getByText(/No recurring schedules yet/)).toBeInTheDocument();
  });
});

describe("TransactionsPanel", () => {
  const page = (over: Record<string, unknown> = {}): any => ({
    items: [
      { id: "t1", investmentId: "a", investmentName: "Active fund", investmentType: "MUTUAL_FUND", type: "CONTRIBUTION", amount: "5000.00", occurredAt: "2026-10-05T00:00:00.000Z", origin: "RECURRING", periodKey: "2026-10", notes: null },
      { id: "t2", investmentId: "a", investmentName: "Active fund", investmentType: "MUTUAL_FUND", type: "SALE", amount: "2000.00", occurredAt: "2026-09-01T00:00:00.000Z", origin: "MANUAL", periodKey: null, notes: "partial" },
    ],
    total: 45,
    page: 1,
    pageSize: 20,
    totalPages: 3,
    totals: { contributed: "5000.00", withdrawn: "2000.00" },
    ...over,
  });

  it("shows the ledger with whole-set totals and server-side paging", async () => {
    inv.transactions.mockResolvedValue(page());
    render(<TransactionsPanel holdings={[portfolioHolding({ id: "a", name: "Active fund" })]} onChanged={jest.fn()} />);
    expect(await screen.findByText(/45 transactions/)).toHaveTextContent("put in ₹5,000 · taken out ₹2,000");
    expect(screen.getByText("from schedule")).toBeInTheDocument();
    expect(inv.transactions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 20, sort: "date_desc" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(inv.transactions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  it("filters go to the server and reset to page 1", async () => {
    inv.transactions.mockResolvedValue(page());
    render(<TransactionsPanel holdings={[portfolioHolding({ id: "a", name: "Active fund" })]} onChanged={jest.fn()} />);
    await screen.findByText(/45 transactions/);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(inv.transactions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "SALE" } });
    await waitFor(() => expect(inv.transactions).toHaveBeenLastCalledWith(expect.objectContaining({ type: "SALE", page: 1 })));
    fireEvent.change(screen.getByLabelText("Holding"), { target: { value: "a" } });
    await waitFor(() => expect(inv.transactions).toHaveBeenLastCalledWith(expect.objectContaining({ investmentId: "a" })));
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "amount_desc" } });
    await waitFor(() => expect(inv.transactions).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "amount_desc" })));
  });

  it("corrects an entry: amount and note go to the server; a generated entry's date is locked", async () => {
    inv.transactions.mockResolvedValue(page());
    inv.updateCashflow.mockResolvedValue({} as any);
    render(<TransactionsPanel holdings={[]} onChanged={jest.fn()} />);
    await screen.findByText(/45 transactions/);
    fireEvent.click(screen.getByRole("button", { name: /Edit Contribution of ₹5,000/ }));
    expect(screen.getByLabelText("Date")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "5500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(inv.updateCashflow).toHaveBeenCalledWith("a", "t1", { amount: 5500, notes: "" }));
  });

  it("rejects a non-positive correction before calling the API", async () => {
    inv.transactions.mockResolvedValue(page());
    render(<TransactionsPanel holdings={[]} onChanged={jest.fn()} />);
    await screen.findByText(/45 transactions/);
    fireEvent.click(screen.getByRole("button", { name: /Edit Contribution/ }));
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("greater than zero");
    expect(inv.updateCashflow).not.toHaveBeenCalled();
  });

  it("deleting asks first", async () => {
    inv.transactions.mockResolvedValue(page());
    inv.removeCashflow.mockResolvedValue({ deleted: true });
    render(<TransactionsPanel holdings={[]} onChanged={jest.fn()} />);
    await screen.findByText(/45 transactions/);
    fireEvent.click(screen.getByRole("button", { name: /Delete Sale proceeds of ₹2,000/ }));
    expect(inv.removeCashflow).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm delete" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(inv.removeCashflow).toHaveBeenCalledWith("a", "t2"));
  });

  it("an empty result explains itself", async () => {
    inv.transactions.mockResolvedValue(page({ items: [], total: 0, totalPages: 1 }));
    render(<TransactionsPanel holdings={[]} onChanged={jest.fn()} />);
    expect(await screen.findByText(/No transactions match/)).toBeInTheDocument();
  });

  it("shows a readable error when loading fails", async () => {
    inv.transactions.mockRejectedValue(new Error("down"));
    render(<TransactionsPanel holdings={[]} onChanged={jest.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load transactions.");
  });
});
