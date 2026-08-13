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
