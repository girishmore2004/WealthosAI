import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickExpenseDialog } from "../QuickExpenseDialog";
import { api, ApiError } from "@/lib/api-client";
import { onFinancialChange } from "@/lib/financial-events";
import { localDateString } from "@/lib/dates";

jest.mock("@/lib/api-client", () => ({
  api: {
    expenses: { quickCreate: jest.fn() },
    receivables: { create: jest.fn() },
    transfers: { create: jest.fn() },
  },
  ApiError: class ApiError extends Error {},
}));

const mocked = api as jest.Mocked<typeof api>;

const categories = [
  { id: "c1", name: "Groceries", type: "NEED", icon: "🛒", isSystem: true },
  { id: "c2", name: "Dining", type: "WANT", icon: null, isSystem: true },
  { id: "c3", name: "SIP Investment", type: "SAVINGS", icon: null, isSystem: true },
] as any;

const impact = {
  basis: "ACTUAL",
  date: localDateString(),
  flowType: "EXPENSE",
  day: { categoryTotal: "500.00", allCategoriesTotal: "500.00" },
  month: { categoryTotal: "8500.00", allCategoriesTotal: "15420.00" },
  year: { categoryTotal: "61000.00", allCategoriesTotal: "190000.00" },
};

const setup = (props: Partial<React.ComponentProps<typeof QuickExpenseDialog>> = {}) =>
  render(<QuickExpenseDialog open onClose={jest.fn()} categories={categories} {...props} />);

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  mocked.expenses.quickCreate.mockResolvedValue({ expense: {} as any, impact: impact as any });
  mocked.receivables.create.mockResolvedValue({} as any);
  mocked.transfers.create.mockResolvedValue({} as any);
});

describe("QuickExpenseDialog", () => {
  it("defaults the date to the user's local today and the method to UPI", () => {
    setup();
    expect(screen.getByLabelText("Date")).toHaveValue(localDateString());
    expect(screen.getByLabelText("Payment method")).toHaveValue("UPI");
  });

  it("never offers a savings/investment category for an expense", () => {
    setup();
    expect(screen.getByRole("option", { name: "Groceries" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "SIP Investment" })).not.toBeInTheDocument();
  });

  it("Part 56: ₹500 Grocery is saved as an expense and shows today / month / year for that category", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Merchant / description"), { target: { value: "Big Basket" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocked.expenses.quickCreate).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId: "c1", amount: 500, merchant: "Big Basket", spentAt: localDateString(), paymentMethod: "UPI" }),
      ),
    );
    expect(await screen.findByText(/Expense saved: ₹500 · Groceries/)).toBeInTheDocument();
    expect(screen.getByText("₹8,500")).toBeInTheDocument(); // this month, Groceries
    expect(screen.getByText("₹61,000")).toBeInTheDocument(); // this year, Groceries
    // Only the expense endpoint was used — nothing for investments, receivables or transfers.
    expect(mocked.receivables.create).not.toHaveBeenCalled();
    expect(mocked.transfers.create).not.toHaveBeenCalled();
  });

  it("announces the change so the page, dashboard and reports refresh without a reload", async () => {
    const seen: string[] = [];
    const off = onFinancialChange((k) => seen.push(k));
    setup();
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(seen).toEqual(["expense"]);
    off();
  });

  it("remembers the last-used category for next time", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c2" } });
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(window.localStorage.getItem("wos.quickExpense.categoryId")).toBe("c2");
  });

  it("sends the chosen repeat cadence and end date with the same request (no separate step)", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "999" } });
    fireEvent.change(screen.getByLabelText("Repeat?"), { target: { value: "MONTHLY" } });
    fireEvent.change(screen.getByLabelText("Stop repeating after (optional)"), { target: { value: "2027-03-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocked.expenses.quickCreate).toHaveBeenCalledWith(expect.objectContaining({ recurrence: "MONTHLY", recurrenceEndDate: "2027-03-31" })),
    );
    expect(await screen.findByText(/Repeats monthly/)).toBeInTheDocument();
  });

  it("does not send a recurrence when Repeat is 'No'", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocked.expenses.quickCreate).toHaveBeenCalled());
    expect(mocked.expenses.quickCreate.mock.calls[0][0].recurrence).toBeUndefined();
  });

  it("'Other outflow' is sent with its own flow type (still an Expense row, excluded from expense totals)", async () => {
    setup();
    fireEvent.click(screen.getByLabelText("Other outflow"));
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "1200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocked.expenses.quickCreate).toHaveBeenCalledWith(expect.objectContaining({ flowType: "OTHER_OUTFLOW" })));
  });

  it("rejects a zero or empty amount before any request is made", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter an amount greater than zero.");
    expect(mocked.expenses.quickCreate).not.toHaveBeenCalled();
  });

  it("surfaces a server error instead of failing silently, and stays open for a retry", async () => {
    mocked.expenses.quickCreate.mockRejectedValueOnce(new ApiError("Category not found"));
    setup();
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Category not found");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("Money given goes to the RECEIVABLES ledger — never saved as an expense", async () => {
    setup();
    fireEvent.click(screen.getByLabelText("Money given"));
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Given to"), { target: { value: "Friend" } });
    fireEvent.click(screen.getByRole("button", { name: "Record money given" }));

    await waitFor(() => expect(mocked.receivables.create).toHaveBeenCalledWith(expect.objectContaining({ person: "Friend", amount: 5000 })));
    expect(mocked.expenses.quickCreate).not.toHaveBeenCalled();
    expect(await screen.findByText(/not an expense/)).toBeInTheDocument();
  });

  it("Money given requires a person", async () => {
    setup();
    fireEvent.click(screen.getByLabelText("Money given"));
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Record money given" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Who did you give the money to?");
    expect(mocked.receivables.create).not.toHaveBeenCalled();
  });

  it("Transfer goes to the TRANSFERS ledger and is described as not income/spending", async () => {
    setup();
    fireEvent.click(screen.getByLabelText("Transfer"));
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "3000" } });
    fireEvent.change(screen.getByLabelText("From account"), { target: { value: "HDFC Savings" } });
    fireEvent.change(screen.getByLabelText("To account"), { target: { value: "Paytm Wallet" } });
    fireEvent.click(screen.getByRole("button", { name: "Record transfer" }));

    await waitFor(() =>
      expect(mocked.transfers.create).toHaveBeenCalledWith(expect.objectContaining({ fromAccount: "HDFC Savings", toAccount: "Paytm Wallet", amount: 3000 })),
    );
    expect(mocked.expenses.quickCreate).not.toHaveBeenCalled();
    expect(await screen.findByText(/does not change your income, expenses or investments/)).toBeInTheDocument();
  });

  it("'Add another' clears the form for the next entry", async () => {
    setup();
    fireEvent.change(screen.getByLabelText("Amount (₹)"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add another" }));
    expect(screen.getByLabelText("Amount (₹)")).toHaveValue(null);
  });
});
