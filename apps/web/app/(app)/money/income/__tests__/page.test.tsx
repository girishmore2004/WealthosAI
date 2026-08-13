import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import IncomePage from "../page";
import { api } from "@/lib/api-client";

jest.mock("@/lib/api-client", () => ({
  api: {
    income: {
      list: jest.fn(),
      listPaged: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      // NEW (audit item #3)
      activateRecurrence: jest.fn(),
      deactivateRecurrence: jest.fn(),
      previewRecurrence: jest.fn(),
      // NEW (audit item #4)
      history: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));

const mockedApi = api as jest.Mocked<typeof api>;

const makeIncome = (id: string, label: string) => ({
  id,
  userId: "u1",
  source: "SALARY",
  label,
  amount: "50000",
  recurrence: "MONTHLY",
  receivedAt: "2026-07-01T00:00:00.000Z",
  currency: "INR",
  notes: null,
  recurrenceActive: false,
  recurrenceEndDate: null,
  nextOccurrenceAt: null,
  generatedFromRecurringId: null,
});

beforeEach(() => jest.clearAllMocks());

describe("IncomePage pagination (new, audit item #16)", () => {
  it("loads page 1 via listPaged() on mount, not the unbounded list()", async () => {
    mockedApi.income.listPaged.mockResolvedValue({
      items: [makeIncome("i1", "Salary")],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });

    render(<IncomePage />);

    await screen.findByText("Salary");
    expect(mockedApi.income.listPaged).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
    expect(mockedApi.income.list).not.toHaveBeenCalled();
  });

  it("shows page count and total, and disables Previous on page 1", async () => {
    mockedApi.income.listPaged.mockResolvedValue({
      items: [makeIncome("i1", "Salary")],
      total: 40,
      page: 1,
      pageSize: 25,
      totalPages: 2,
    });

    render(<IncomePage />);
    await screen.findByText("Salary");

    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/40 total/)).toBeInTheDocument();
    expect(screen.getByText("Previous")).toBeDisabled();
    expect(screen.getByText("Next")).not.toBeDisabled();
  });

  it("fetches the next page when Next is clicked", async () => {
    mockedApi.income.listPaged.mockResolvedValueOnce({
      items: [makeIncome("i1", "Salary")],
      total: 40,
      page: 1,
      pageSize: 25,
      totalPages: 2,
    });

    render(<IncomePage />);
    await screen.findByText("Salary");

    mockedApi.income.listPaged.mockResolvedValueOnce({
      items: [makeIncome("i2", "Freelance")],
      total: 40,
      page: 2,
      pageSize: 25,
      totalPages: 2,
    });

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => expect(mockedApi.income.listPaged).toHaveBeenCalledWith({ page: 2, pageSize: 25 }));
    await screen.findByText("Freelance");
    expect(screen.getByText("Next")).toBeDisabled(); // now on the last page
  });

  it("reloads page 1 after adding a new entry so it's visible under newest-first ordering", async () => {
    mockedApi.income.listPaged.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 });
    mockedApi.income.create.mockResolvedValue(makeIncome("i1", "New salary") as any);

    render(<IncomePage />);
    await screen.findByText(/No income logged yet/i);

    fireEvent.change(screen.getByPlaceholderText("Label (e.g. Monthly salary)"), { target: { value: "New salary" } });
    fireEvent.change(screen.getByPlaceholderText("Amount (₹)"), { target: { value: "50000" } });
    fireEvent.click(screen.getByText("Add income"));

    await waitFor(() => expect(mockedApi.income.create).toHaveBeenCalled());
    await waitFor(() => expect(mockedApi.income.listPaged).toHaveBeenLastCalledWith({ page: 1, pageSize: 25 }));
  });

  it("steps back a page when deleting the only item on a later page", async () => {
    mockedApi.income.listPaged.mockResolvedValueOnce({
      items: [makeIncome("i5", "Last on page 2")],
      total: 26,
      page: 2,
      pageSize: 25,
      totalPages: 2,
    });
    mockedApi.income.remove.mockResolvedValue(undefined);

    render(<IncomePage />);
    await screen.findByText("Last on page 2");

    mockedApi.income.listPaged.mockResolvedValueOnce({
      items: Array.from({ length: 25 }, (_, i) => makeIncome(`i${i}`, `Row ${i}`)),
      total: 25,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });

    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() => expect(mockedApi.income.listPaged).toHaveBeenLastCalledWith({ page: 1, pageSize: 25 }));
  });
});

describe("IncomePage recurrence toggle (new, audit item #3)", () => {
  it("shows 'Make recurring' for a non-ONE_TIME, non-generated row and activates it on click", async () => {
    mockedApi.income.listPaged.mockResolvedValue({
      items: [makeIncome("i1", "Salary")],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    mockedApi.income.activateRecurrence.mockResolvedValue({} as any);

    render(<IncomePage />);
    await screen.findByText("Salary");

    fireEvent.click(screen.getByText("Make recurring"));

    await waitFor(() => expect(mockedApi.income.activateRecurrence).toHaveBeenCalledWith("i1"));
  });

  it("shows 'Auto-generating ✓' and deactivates on click when already active", async () => {
    mockedApi.income.listPaged.mockResolvedValue({
      items: [{ ...makeIncome("i1", "Salary"), recurrenceActive: true }],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    mockedApi.income.deactivateRecurrence.mockResolvedValue({} as any);

    render(<IncomePage />);
    await screen.findByText("Salary");

    fireEvent.click(screen.getByText("Auto-generating ✓"));

    await waitFor(() => expect(mockedApi.income.deactivateRecurrence).toHaveBeenCalledWith("i1"));
  });

  it("does not show the toggle for a ONE_TIME row", async () => {
    mockedApi.income.listPaged.mockResolvedValue({
      items: [{ ...makeIncome("i1", "Bonus"), recurrence: "ONE_TIME" }],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });

    render(<IncomePage />);
    await screen.findByText("Bonus");

    expect(screen.queryByText("Make recurring")).not.toBeInTheDocument();
  });

  it("does not show the toggle, and shows an 'auto-generated' label instead, for a system-generated row", async () => {
    mockedApi.income.listPaged.mockResolvedValue({
      items: [{ ...makeIncome("i1", "Salary"), generatedFromRecurringId: "template-1" }],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });

    render(<IncomePage />);
    await screen.findByText("Salary");

    expect(screen.queryByText("Make recurring")).not.toBeInTheDocument();
    expect(screen.getByText("auto-generated")).toBeInTheDocument();
  });
});

describe("IncomePage amount-change history (new, audit item #4)", () => {
  it("fetches and displays history entries when 'History' is clicked", async () => {
    mockedApi.income.listPaged.mockResolvedValue({
      items: [makeIncome("i1", "Salary")],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    mockedApi.income.history.mockResolvedValue([
      { id: "h1", userId: "u1", incomeId: "i1", previousAmount: "50000", newAmount: "60000", effectiveFrom: "2026-07-01T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" },
    ]);

    render(<IncomePage />);
    await screen.findByText("Salary");

    fireEvent.click(screen.getByText("History"));

    await waitFor(() => expect(mockedApi.income.history).toHaveBeenCalledWith("i1"));
    expect(await screen.findByText(/effective/i)).toBeInTheDocument();
  });

  it("shows a 'no changes logged' message for a row with an empty history", async () => {
    mockedApi.income.listPaged.mockResolvedValue({
      items: [makeIncome("i1", "Salary")],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    mockedApi.income.history.mockResolvedValue([]);

    render(<IncomePage />);
    await screen.findByText("Salary");

    fireEvent.click(screen.getByText("History"));

    expect(await screen.findByText(/No amount changes logged/i)).toBeInTheDocument();
  });

  it("collapses the panel when 'History' is clicked again", async () => {
    mockedApi.income.listPaged.mockResolvedValue({
      items: [makeIncome("i1", "Salary")],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    mockedApi.income.history.mockResolvedValue([]);

    render(<IncomePage />);
    await screen.findByText("Salary");

    fireEvent.click(screen.getByText("History"));
    await screen.findByText(/No amount changes logged/i);

    fireEvent.click(screen.getByText("History"));

    expect(screen.queryByText(/No amount changes logged/i)).not.toBeInTheDocument();
  });
});
