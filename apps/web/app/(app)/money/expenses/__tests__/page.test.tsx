import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import ExpensesPage from "../page";
import { api } from "@/lib/api-client";
import { localDateString } from "@/lib/dates";

jest.mock("@/lib/api-client", () => ({
  api: {
    expenses: {
      list: jest.fn(),
      listPaged: jest.fn(),
      categories: jest.fn(),
      summary: jest.fn(),
      analytics: jest.fn(),
      quickCreate: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      activateRecurrence: jest.fn(),
      deactivateRecurrence: jest.fn(),
      updateRule: jest.fn(),
    },
    financialCore: { moneyFlow: jest.fn() },
    receivables: { summary: jest.fn(), list: jest.fn() },
    transfers: { list: jest.fn() },
    emergencyFund: { entries: jest.fn() },
  },
  ApiError: class ApiError extends Error {},
}));

// recharts needs real layout (ResponsiveContainer measures its parent), which jsdom doesn't have.
jest.mock("@/components/expenses/SpendingTrendChart", () => ({
  SpendingTrendChart: () => <div data-testid="trend-chart" />,
}));

const mocked = api as jest.Mocked<typeof api>;
const TODAY = localDateString();

const makeExpense = (id: string, merchant: string, extra: Record<string, unknown> = {}) => ({
  id,
  userId: "u1",
  categoryId: "c1",
  category: { id: "c1", name: "Groceries", isSystem: true },
  merchant,
  amount: "1200",
  spentAt: "2026-07-01T00:00:00.000Z",
  paymentMethod: "UPI",
  isRecurring: false,
  notes: null,
  recurrence: null,
  recurrenceActive: false,
  recurrenceEndDate: null,
  nextOccurrenceAt: null,
  generatedFromRecurringId: null,
  flowType: "EXPENSE",
  ...extra,
});

const page = (items: any[], over: Record<string, unknown> = {}) => ({ items, total: items.length, page: 1, pageSize: 25, totalPages: 1, ...over });

const analyticsData = {
  basis: "ACTUAL",
  currency: "INR",
  period: { from: "2026-10-01", to: "2026-10-31", days: 31, elapsedDays: 4 },
  filters: { categoryId: null, flowType: "EXPENSE" },
  totals: { total: "8500.00", transactionCount: 4, averagePerTransaction: "2125.00", averagePerDay: "2125.00", largest: null, smallest: null },
  highestDay: { date: "2026-10-03", total: "5500.00" },
  lowestDay: null,
  daily: [],
  weekly: [],
  monthly: [],
  categories: [{ categoryId: "c1", name: "Groceries", type: "NEED", icon: "🛒", total: "8500.00", count: 4, sharePercent: 100, previousTotal: "7200.00", changePercent: 18.1 }],
  comparison: { from: "2026-09-01", to: "2026-09-30", total: "7200.00", change: "1300.00", changePercent: 18.1 },
  yearOverYear: null,
  overall: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked.expenses.categories.mockResolvedValue([
    { id: "c1", name: "Groceries", type: "NEED", icon: "🛒", isSystem: true },
    { id: "c2", name: "SIP Investment", type: "SAVINGS", icon: null, isSystem: true },
  ] as any);
  mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("e1", "Big Bazaar")]));
  mocked.expenses.summary.mockResolvedValue({ basis: "ACTUAL", currency: "INR", date: TODAY, flowType: "EXPENSE", today: "500.00", month: "15420.00", year: "190000.00" });
  mocked.expenses.analytics.mockResolvedValue(analyticsData as any);
  mocked.financialCore.moneyFlow.mockResolvedValue({
    outflows: { expenses: "15420.00", investments: "10000.00", emergencyFund: "7000.00", receivablesGiven: "5000.00", otherOutflow: "0.00" },
    totalGenuineOutflow: "37420.00",
  } as any);
  mocked.receivables.summary.mockResolvedValue({ totalOutstanding: "5000.00" } as any);
  mocked.receivables.list.mockResolvedValue([]);
  mocked.transfers.list.mockResolvedValue([]);
  mocked.emergencyFund.entries.mockResolvedValue([]);
});

describe("ExpensesPage — transactions & pagination", () => {
  it("loads page 1 via listPaged() with the default filters and the user's LOCAL today, never the unbounded list()", async () => {
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    expect(mocked.expenses.listPaged).toHaveBeenCalledWith({ page: 1, pageSize: 25, period: "THIS_MONTH", today: TODAY, sort: "NEWEST" });
    expect(mocked.expenses.list).not.toHaveBeenCalled();
  });

  it("shows page count and total, and disables Next on the last page", async () => {
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    expect(screen.getByText(/Page 1 of 1/)).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeDisabled();
  });

  it("fetches the next page when Next is clicked", async () => {
    mocked.expenses.listPaged.mockResolvedValueOnce(page([makeExpense("e1", "Big Bazaar")], { total: 40, totalPages: 2 }));
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");

    mocked.expenses.listPaged.mockResolvedValueOnce(page([makeExpense("e2", "Zomato")], { total: 40, page: 2, totalPages: 2 }));
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => expect(mocked.expenses.listPaged).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 25 })));
    await screen.findByText("Zomato");
  });

  it("shows an empty state with a way back when filters match nothing", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([]));
    render(<ExpensesPage />);
    expect(await screen.findByText("No expenses match these filters.")).toBeInTheDocument();
    expect(screen.getByText("Reset filters")).toBeInTheDocument();
  });

  it("shows a retryable error when the list fails to load", async () => {
    mocked.expenses.listPaged.mockRejectedValueOnce(new Error("network"));
    render(<ExpensesPage />);
    expect(await screen.findByText(/Could not load expenses/)).toBeInTheDocument();
    mocked.expenses.listPaged.mockResolvedValueOnce(page([makeExpense("e1", "Big Bazaar")]));
    fireEvent.click(screen.getByText("Retry"));
    await screen.findByText("Big Bazaar");
  });
});

describe("ExpensesPage — summary keeps spending separate from other money flows", () => {
  it("shows today / month / year / average from the API, with no arithmetic done in the browser", async () => {
    render(<ExpensesPage />);
    expect(await screen.findByText("₹15,420")).toBeInTheDocument(); // month
    expect(screen.getByText("₹1,90,000")).toBeInTheDocument(); // year, Indian digit grouping
    expect(screen.getAllByText("₹2,125").length).toBeGreaterThan(0); // average per day
  });

  it("puts investments, emergency fund, money lent and total outflow in their OWN group, labelled 'not counted as expenses'", async () => {
    render(<ExpensesPage />);
    const heading = await screen.findByText(/Where else your money went/);
    expect(heading).toHaveTextContent("not counted as expenses");
    const group = heading.closest("section") as HTMLElement;
    expect(within(group).getByText("Refundable outstanding")).toBeInTheDocument();
    expect(within(group).getByText("₹5,000")).toBeInTheDocument();
    expect(within(group).getByText("₹10,000")).toBeInTheDocument(); // investments
    expect(within(group).getByText("₹7,000")).toBeInTheDocument(); // emergency fund
    expect(within(group).getByText("₹37,420")).toBeInTheDocument(); // total cash outflow
  });

  it("still renders the page when the supplementary summary calls fail", async () => {
    mocked.expenses.summary.mockRejectedValue(new Error("down"));
    mocked.financialCore.moneyFlow.mockRejectedValue(new Error("down"));
    mocked.receivables.summary.mockRejectedValue(new Error("down"));
    render(<ExpensesPage />);
    expect(await screen.findByText("Big Bazaar")).toBeInTheDocument();
  });
});

describe("ExpensesPage — filters", () => {
  it("changing the date preset refetches the list AND analytics for that period, from page 1", async () => {
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "LAST_MONTH" } });
    await waitFor(() => expect(mocked.expenses.listPaged).toHaveBeenLastCalledWith(expect.objectContaining({ period: "LAST_MONTH", page: 1, today: TODAY })));
    await waitFor(() => expect(mocked.expenses.analytics).toHaveBeenLastCalledWith(expect.objectContaining({ period: "LAST_MONTH", flowType: "EXPENSE" })));
  });

  it("passes category, payment method and sort to the API", async () => {
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c1" } });
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "CASH" } });
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "HIGHEST" } });
    await waitFor(() =>
      expect(mocked.expenses.listPaged).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: "c1", paymentMethod: "CASH", sort: "HIGHEST" })),
    );
  });

  it("does not offer a savings category as a spending filter", async () => {
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    const select = screen.getByLabelText("Category");
    expect(within(select).queryByText("SIP Investment")).not.toBeInTheDocument();
  });

  it("a custom range sends nothing until BOTH dates are chosen", async () => {
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    mocked.expenses.listPaged.mockClear();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "CUSTOM" } });
    expect(await screen.findByText(/Choose both a start and an end date/)).toBeInTheDocument();
    expect(mocked.expenses.listPaged).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-03" } });
    await waitFor(() =>
      expect(mocked.expenses.listPaged).toHaveBeenLastCalledWith(expect.objectContaining({ period: "CUSTOM", from: "2026-10-01", to: "2026-10-03" })),
    );
  });

  it("the Refundable type shows the RECEIVABLES ledger (not expense rows) and stops querying expenses", async () => {
    mocked.receivables.list.mockResolvedValue([
      { id: "r1", person: "Friend", originalAmount: "5000.00", returnedAmount: "0.00", outstandingAmount: "5000.00", givenAt: "2026-10-01T00:00:00Z", effectiveStatus: "OUTSTANDING", status: "OUTSTANDING" },
    ] as any);
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    mocked.expenses.listPaged.mockClear();

    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "REFUNDABLE" } });
    expect(await screen.findByText("Friend")).toBeInTheDocument();
    expect(screen.getByText("Not an expense")).toBeInTheDocument();
    expect(screen.queryByText("Big Bazaar")).not.toBeInTheDocument();
    expect(mocked.expenses.listPaged).not.toHaveBeenCalled();
  });

  it("the Emergency fund and Transfer types read their own ledgers", async () => {
    mocked.emergencyFund.entries.mockResolvedValue([{ id: "n1", type: "ALLOCATE", amount: "7000.00", occurredAt: "2026-10-01T00:00:00Z", notes: null }] as any);
    mocked.transfers.list.mockResolvedValue([{ id: "t1", fromAccount: "HDFC", toAccount: "Wallet", amount: "3000.00", transferredAt: "2026-10-02T00:00:00Z", notes: null }] as any);
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");

    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "EMERGENCY" } });
    expect(await screen.findByText("Added")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "TRANSFER" } });
    expect(await screen.findByText("HDFC → Wallet")).toBeInTheDocument();
  });
});

describe("ExpensesPage — category drill-down", () => {
  it("clicking a category opens its analytics, scoped to that category", async () => {
    render(<ExpensesPage />);
    const row = await screen.findByRole("button", { name: /Groceries, ₹8,500/ });
    expect(within(row).getByText("▲ +18.1%")).toBeInTheDocument(); // spec example: +18.1% vs previous month

    mocked.expenses.analytics.mockResolvedValue({ ...analyticsData, filters: { categoryId: "c1", flowType: "EXPENSE" }, overall: { total: "38000.00", sharePercent: 22.4 } } as any);
    fireEvent.click(row);

    const dialog = await screen.findByRole("dialog", { name: "Groceries" });
    await waitFor(() => expect(mocked.expenses.analytics).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "c1", period: "THIS_MONTH", today: TODAY })));
    expect(await within(dialog).findByText("22.4%")).toBeInTheDocument(); // share of all expenses
    expect(within(dialog).getByText("This month")).toBeInTheDocument();
  });

  it("switching the drill-down tab requests that period for the same category", async () => {
    render(<ExpensesPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Groceries, ₹8,500/ }));
    const dialog = await screen.findByRole("dialog", { name: "Groceries" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Last month" }));
    await waitFor(() => expect(mocked.expenses.analytics).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: "c1", period: "LAST_MONTH" })));
  });
});

describe("ExpensesPage — Quick expense", () => {
  it("has a prominent Quick expense action that opens the quick form", async () => {
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    fireEvent.click(screen.getByRole("button", { name: "+ Quick expense" }));
    expect(await screen.findByRole("dialog", { name: "Quick add" })).toBeInTheDocument();
  });

  it("after a quick expense is saved the page refetches its numbers without a browser reload", async () => {
    mocked.expenses.quickCreate.mockResolvedValue({
      expense: {} as any,
      impact: { day: { categoryTotal: "500.00", allCategoriesTotal: "500.00" }, month: { categoryTotal: "9000.00", allCategoriesTotal: "9000.00" }, year: { categoryTotal: "9000.00", allCategoriesTotal: "9000.00" } } as any,
    });
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    const before = mocked.expenses.summary.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "+ Quick expense" }));
    const dialog = await screen.findByRole("dialog", { name: "Quick add" });
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocked.expenses.summary.mock.calls.length).toBeGreaterThan(before));
    expect(mocked.expenses.listPaged.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("ExpensesPage — safe deletion", () => {
  it("asks before deleting, and only deletes after confirmation", async () => {
    mocked.expenses.remove.mockResolvedValue(undefined as any);
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");

    fireEvent.click(screen.getByText("Remove"));
    expect(screen.getByText("Delete this expense?")).toBeInTheDocument();
    expect(mocked.expenses.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocked.expenses.remove).toHaveBeenCalledWith("e1"));
  });

  it("'Keep' cancels the deletion", async () => {
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(mocked.expenses.remove).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete this expense?")).not.toBeInTheDocument();
  });

  it("will not offer to delete the template of an ACTIVE repeat — it offers to stop the repeat instead (history kept)", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("e1", "Netflix", { recurrenceActive: true, recurrence: "MONTHLY" })]));
    mocked.expenses.deactivateRecurrence.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Remove"));
    expect(screen.getByText(/Stop the repeat first \(your history is kept\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop repeating" }));
    await waitFor(() => expect(mocked.expenses.deactivateRecurrence).toHaveBeenCalledWith("e1"));
    expect(mocked.expenses.remove).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Everything already recorded was kept");
  });

  it("a generated occurrence offers: only this entry, this and all later entries, or just stop repeating", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("o2", "Netflix", { generatedFromRecurringId: "t1" })]));
    mocked.expenses.remove.mockResolvedValue(undefined as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Remove"));
    const group = screen.getByRole("group", { name: "Delete options" });
    expect(within(group).getByRole("button", { name: "Only this entry" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Just stop repeating" })).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("button", { name: "This and all later entries" }));
    await waitFor(() => expect(mocked.expenses.remove).toHaveBeenCalledWith("o2", "FUTURE"));
    expect(await screen.findByRole("status")).toHaveTextContent("Earlier history and the repeat were kept");
  });

  it("'Only this entry' deletes just that occurrence", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("o2", "Netflix", { generatedFromRecurringId: "t1" })]));
    mocked.expenses.remove.mockResolvedValue(undefined as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByRole("button", { name: "Only this entry" }));
    await waitFor(() => expect(mocked.expenses.remove).toHaveBeenCalledWith("o2", "THIS"));
  });

  it("'Just stop repeating' stops the TEMPLATE's repeat and deletes nothing", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("o2", "Netflix", { generatedFromRecurringId: "t1" })]));
    mocked.expenses.deactivateRecurrence.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByRole("button", { name: "Just stop repeating" }));
    await waitFor(() => expect(mocked.expenses.deactivateRecurrence).toHaveBeenCalledWith("t1"));
    expect(mocked.expenses.remove).not.toHaveBeenCalled();
  });

  it("a paused repeat's template can be deleted with the ordinary confirmation", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("e1", "Netflix", { recurrence: "MONTHLY", recurrenceActive: false })]));
    mocked.expenses.remove.mockResolvedValue(undefined as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Remove"));
    expect(screen.getByText("Delete this expense?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocked.expenses.remove).toHaveBeenCalledWith("e1"));
  });

  it("shows the server's message when a delete fails", async () => {
    const { ApiError } = jest.requireMock("@/lib/api-client");
    mocked.expenses.remove.mockRejectedValue(new ApiError("Expense not found"));
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Expense not found")).toBeInTheDocument();
  });
});

describe("ExpensesPage — flow-type and recurrence display", () => {
  it("labels an Other-outflow row so it is never mistaken for ordinary spending", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("e1", "Court fee", { flowType: "OTHER_OUTFLOW" })]));
    render(<ExpensesPage />);
    const row = (await screen.findByText("Court fee")).closest("li") as HTMLElement;
    // Scoped to the row: "Other outflow" is also an option in the Type filter.
    expect(within(row).getByText("Other outflow")).toBeInTheDocument();
  });

  it("'Make recurring' opens a cadence choice that defaults to Monthly", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("e1", "Netflix")]));
    mocked.expenses.activateRecurrence.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Make recurring"));
    const dialog = await screen.findByRole("dialog", { name: "Make this repeat" });
    expect(within(dialog).getByLabelText("Repeat")).toHaveValue("MONTHLY");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start repeating" }));
    await waitFor(() => expect(mocked.expenses.activateRecurrence).toHaveBeenCalledWith("e1", "MONTHLY", undefined));
  });

  it("offers a biweekly cadence (every 2 weeks) and an optional end date", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("e1", "Maid")]));
    mocked.expenses.activateRecurrence.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Maid");
    fireEvent.click(screen.getByText("Make recurring"));
    const dialog = await screen.findByRole("dialog", { name: "Make this repeat" });
    expect(within(dialog).getByRole("option", { name: "Every 2 weeks" })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Repeat"), { target: { value: "BIWEEKLY" } });
    fireEvent.change(within(dialog).getByLabelText("Stop after (optional)"), { target: { value: "2027-03-31" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start repeating" }));
    await waitFor(() => expect(mocked.expenses.activateRecurrence).toHaveBeenCalledWith("e1", "BIWEEKLY", "2027-03-31"));
    expect(await screen.findByRole("status")).toHaveTextContent("Repeating every 2 weeks");
  });

  it("shows the cadence on an actively repeating row, and resumes a paused one with its own cadence", async () => {
    mocked.expenses.listPaged.mockResolvedValue(
      page([makeExpense("e1", "Netflix", { recurrence: "BIWEEKLY", recurrenceActive: true }), makeExpense("e2", "Gym", { recurrence: "WEEKLY", recurrenceActive: false })]),
    );
    mocked.expenses.activateRecurrence.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    expect(screen.getByText("repeats every 2 weeks")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Resume repeat"));
    await waitFor(() => expect(mocked.expenses.activateRecurrence).toHaveBeenCalledWith("e2", "WEEKLY"));
  });

  it("deactivates on click when already active", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("e1", "Netflix", { recurrenceActive: true, recurrence: "MONTHLY" })]));
    mocked.expenses.deactivateRecurrence.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Auto-generating ✓"));
    await waitFor(() => expect(mocked.expenses.deactivateRecurrence).toHaveBeenCalledWith("e1"));
  });

  it("does not show the toggle, and shows an 'auto-generated' label instead, for a system-generated row", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("e1", "Netflix", { generatedFromRecurringId: "template-1" })]));
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    expect(screen.queryByText("Make recurring")).not.toBeInTheDocument();
    expect(screen.getByText("auto-generated")).toBeInTheDocument();
  });
});

describe("ExpensesPage — editing a recurring expense (spec Part 11)", () => {
  const saveEdit = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const setAmount = (v: string) => fireEvent.change(screen.getByPlaceholderText("Amount (₹)"), { target: { value: v } });

  it("an ordinary expense edits straight away — no scope question", async () => {
    mocked.expenses.update.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.queryByText("This occurrence only")).not.toBeInTheDocument();
    setAmount("1300");
    saveEdit();
    await waitFor(() => expect(mocked.expenses.update).toHaveBeenCalledWith("e1", expect.objectContaining({ amount: 1300 })));
  });

  it("a generated occurrence asks which occurrences the edit applies to, and says earlier ones never change", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("o2", "Netflix", { generatedFromRecurringId: "t1" })]));
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Edit"));
    const group = screen.getByRole("group", { name: "Apply this edit to" });
    expect(within(group).getByRole("button", { name: "This occurrence only" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "This and future occurrences" })).toBeInTheDocument();
    expect(within(group).getByText("Earlier entries are never changed.")).toBeInTheDocument();
    expect(mocked.expenses.update).not.toHaveBeenCalled();
  });

  it("'This occurrence only' saves with scope THIS and includes the date", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("o2", "Netflix", { generatedFromRecurringId: "t1" })]));
    mocked.expenses.update.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByRole("button", { name: "This occurrence only" }));
    setAmount("1500");
    saveEdit();
    await waitFor(() => expect(mocked.expenses.update).toHaveBeenCalledWith("o2", expect.objectContaining({ amount: 1500, spentAt: expect.any(String) }), "THIS"));
  });

  it("'This and future occurrences' saves with scope FUTURE and does not offer the date (a date is never changed in bulk)", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("o2", "Netflix", { generatedFromRecurringId: "t1" })]));
    mocked.expenses.update.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByRole("button", { name: "This and future occurrences" }));
    expect(screen.queryByPlaceholderText("Date spent")).not.toBeInTheDocument();
    setAmount("1100");
    saveEdit();
    await waitFor(() => expect(mocked.expenses.update).toHaveBeenCalled());
    const [id, payload, scope] = mocked.expenses.update.mock.calls[0];
    expect([id, scope]).toEqual(["o2", "FUTURE"]);
    expect(payload).toMatchObject({ amount: 1100 });
    expect(payload).not.toHaveProperty("spentAt");
    expect(await screen.findByRole("status")).toHaveTextContent("Earlier ones were not changed");
  });

  it("the template row of an active repeat asks the same question", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("t1", "Netflix", { recurrence: "MONTHLY", recurrenceActive: true })]));
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByRole("group", { name: "Apply this edit to" })).toBeInTheDocument();
  });

  it("'Change how it repeats' edits the rule only and reassures that existing entries stay", async () => {
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("t1", "Netflix", { recurrence: "MONTHLY", recurrenceActive: true })]));
    mocked.expenses.updateRule.mockResolvedValue({} as any);
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByRole("button", { name: "Change how it repeats" }));

    const dialog = await screen.findByRole("dialog", { name: "Edit the repeat" });
    expect(within(dialog).getByText(/Everything already recorded stays exactly as it is/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Repeat"), { target: { value: "BIWEEKLY" } });
    fireEvent.change(within(dialog).getByLabelText("Amount each time (₹)"), { target: { value: "1100" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save repeat" }));

    await waitFor(() => expect(mocked.expenses.updateRule).toHaveBeenCalledWith("t1", { recurrence: "BIWEEKLY", amount: 1100, clearEndDate: true }));
    expect(mocked.expenses.update).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Entries that already exist were not changed");
  });

  it("shows the server's message when the rule cannot be saved", async () => {
    const { ApiError } = jest.requireMock("@/lib/api-client");
    mocked.expenses.listPaged.mockResolvedValue(page([makeExpense("t1", "Netflix", { recurrence: "MONTHLY", recurrenceActive: true })]));
    mocked.expenses.updateRule.mockRejectedValue(new ApiError("The end date cannot be before the first expense date"));
    render(<ExpensesPage />);
    await screen.findByText("Netflix");
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByRole("button", { name: "Change how it repeats" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the repeat" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save repeat" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("end date cannot be before");
  });
});
