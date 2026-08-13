import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ExpensesPage from "../page";
import { api } from "@/lib/api-client";

jest.mock("@/lib/api-client", () => ({
  api: {
    expenses: {
      list: jest.fn(),
      listPaged: jest.fn(),
      categories: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      breakdown: jest.fn(),
      // NEW (audit item #3)
      activateRecurrence: jest.fn(),
      deactivateRecurrence: jest.fn(),
      previewRecurrence: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));

jest.mock("@/components/expenses/ExpenseBreakdownChart", () => ({
  ExpenseBreakdownChart: () => <div data-testid="chart-stub" />,
}));

const mockedApi = api as jest.Mocked<typeof api>;

const makeExpense = (id: string, merchant: string) => ({
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
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedApi.expenses.categories.mockResolvedValue([{ id: "c1", name: "Groceries", isSystem: true }] as any);
});

describe("ExpensesPage pagination (new, audit item #16)", () => {
  it("loads page 1 via listPaged() on mount, not the unbounded list()", async () => {
    mockedApi.expenses.listPaged.mockResolvedValue({
      items: [makeExpense("e1", "Big Bazaar")],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });

    render(<ExpensesPage />);

    await screen.findByText("Big Bazaar");
    expect(mockedApi.expenses.listPaged).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
    expect(mockedApi.expenses.list).not.toHaveBeenCalled();
  });

  it("shows page count and total, and disables Next on the last page", async () => {
    mockedApi.expenses.listPaged.mockResolvedValue({
      items: [makeExpense("e1", "Big Bazaar")],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });

    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");

    expect(screen.getByText(/Page 1 of 1/)).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeDisabled();
  });

  it("fetches the next page when Next is clicked", async () => {
    mockedApi.expenses.listPaged.mockResolvedValueOnce({
      items: [makeExpense("e1", "Big Bazaar")],
      total: 40,
      page: 1,
      pageSize: 25,
      totalPages: 2,
    });

    render(<ExpensesPage />);
    await screen.findByText("Big Bazaar");

    mockedApi.expenses.listPaged.mockResolvedValueOnce({
      items: [makeExpense("e2", "Zomato")],
      total: 40,
      page: 2,
      pageSize: 25,
      totalPages: 2,
    });

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => expect(mockedApi.expenses.listPaged).toHaveBeenCalledWith({ page: 2, pageSize: 25 }));
    await screen.findByText("Zomato");
  });

  it("still renders the ExpenseBreakdownChart alongside the paginated list", async () => {
    mockedApi.expenses.listPaged.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 });

    render(<ExpensesPage />);

    expect(await screen.findByTestId("chart-stub")).toBeInTheDocument();
  });
});

describe("ExpensesPage recurrence toggle (new, audit item #3)", () => {
  it("activates with a default MONTHLY cadence when no recurrence is set yet", async () => {
    mockedApi.expenses.listPaged.mockResolvedValue({
      items: [makeExpense("e1", "Netflix")],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    mockedApi.expenses.activateRecurrence.mockResolvedValue({} as any);

    render(<ExpensesPage />);
    await screen.findByText("Netflix");

    fireEvent.click(screen.getByText("Make recurring"));

    await waitFor(() => expect(mockedApi.expenses.activateRecurrence).toHaveBeenCalledWith("e1", "MONTHLY"));
  });

  it("deactivates on click when already active", async () => {
    mockedApi.expenses.listPaged.mockResolvedValue({
      items: [{ ...makeExpense("e1", "Netflix"), recurrenceActive: true, recurrence: "MONTHLY" }],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    mockedApi.expenses.deactivateRecurrence.mockResolvedValue({} as any);

    render(<ExpensesPage />);
    await screen.findByText("Netflix");

    fireEvent.click(screen.getByText("Auto-generating ✓"));

    await waitFor(() => expect(mockedApi.expenses.deactivateRecurrence).toHaveBeenCalledWith("e1"));
  });

  it("does not show the toggle, and shows an 'auto-generated' label instead, for a system-generated row", async () => {
    mockedApi.expenses.listPaged.mockResolvedValue({
      items: [{ ...makeExpense("e1", "Netflix"), generatedFromRecurringId: "template-1" }],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });

    render(<ExpensesPage />);
    await screen.findByText("Netflix");

    expect(screen.queryByText("Make recurring")).not.toBeInTheDocument();
    expect(screen.getByText("auto-generated")).toBeInTheDocument();
  });
});
