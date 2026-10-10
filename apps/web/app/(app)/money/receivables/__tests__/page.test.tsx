import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import ReceivablesPage from "../page";
import { api } from "@/lib/api-client";

jest.mock("@/lib/api-client", () => ({
  api: {
    receivables: {
      list: jest.fn(),
      summary: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      recordRepayment: jest.fn(),
      removeRepayment: jest.fn(),
      cancel: jest.fn(),
      remove: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));

const mocked = api as jest.Mocked<typeof api>;

const make = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  person: "Friend",
  purpose: null,
  originalAmount: "5000.00",
  returnedAmount: "0.00",
  outstandingAmount: "5000.00",
  currency: "INR",
  givenAt: "2026-09-01T00:00:00.000Z",
  expectedReturnAt: null,
  status: "OUTSTANDING",
  effectiveStatus: "OUTSTANDING",
  daysUntilDue: null,
  paymentMethod: "UPI",
  notes: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const summary = {
  basis: "ACTUAL",
  currency: "INR",
  totalOutstanding: "15000.00",
  activeCount: 3,
  dueSoon: { amount: "5000.00", count: 1, withinDays: 7 },
  overdue: { amount: "3000.00", count: 1 },
  returnedThisMonth: "2000.00",
  largest: { id: "r9", person: "Landlord", outstandingAmount: "9000.00" },
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked.receivables.list.mockResolvedValue([make()] as any);
  mocked.receivables.summary.mockResolvedValue(summary as any);
  mocked.receivables.get.mockResolvedValue(make({ repayments: [] }) as any);
});

describe("ReceivablesPage", () => {
  it("shows total outstanding, due soon, overdue, returned this month and the largest — all from the API", async () => {
    render(<ReceivablesPage />);
    expect(await screen.findByText("₹15,000")).toBeInTheDocument();
    expect(screen.getAllByText("₹5,000").length).toBeGreaterThan(0);
    expect(screen.getByText("₹3,000")).toBeInTheDocument();
    expect(screen.getByText("₹2,000")).toBeInTheDocument();
    expect(screen.getByText("₹9,000")).toBeInTheDocument();
    expect(screen.getByText("Landlord")).toBeInTheDocument();
  });

  it("states plainly that it is never an expense", async () => {
    render(<ReceivablesPage />);
    expect(await screen.findByText(/never counted as an expense/)).toBeInTheDocument();
  });

  it("marks an overdue receivable with how late it is (text, not just colour)", async () => {
    mocked.receivables.list.mockResolvedValue([make({ effectiveStatus: "OVERDUE", expectedReturnAt: "2026-09-20T00:00:00Z", daysUntilDue: -3 })] as any);
    render(<ReceivablesPage />);
    const row = (await screen.findByText("Friend")).closest("li") as HTMLElement;
    expect(within(row).getByText("Overdue")).toBeInTheDocument();
    expect(row).toHaveTextContent("3 days overdue");
  });

  it("filters by scope through the API", async () => {
    render(<ReceivablesPage />);
    await screen.findByText("Friend");
    fireEvent.click(screen.getByRole("tab", { name: "Fully returned" }));
    await waitFor(() => expect(mocked.receivables.list).toHaveBeenLastCalledWith("CLOSED"));
  });

  it("shows an empty state", async () => {
    mocked.receivables.list.mockResolvedValue([]);
    render(<ReceivablesPage />);
    expect(await screen.findByText(/Nothing is outstanding/)).toBeInTheDocument();
  });

  it("shows an error state when loading fails", async () => {
    mocked.receivables.list.mockRejectedValue(new Error("down"));
    render(<ReceivablesPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load receivables.");
  });

  describe("recording a return (Part 57)", () => {
    it("records ₹2,000 against the receivable and tells the user what is still outstanding", async () => {
      mocked.receivables.recordRepayment.mockResolvedValue({
        receivable: make({ status: "PARTIALLY_RETURNED", outstandingAmount: "3000.00", returnedAmount: "2000.00" }),
        repayment: {},
        duplicate: false,
      } as any);
      render(<ReceivablesPage />);
      await screen.findByText("Friend");

      fireEvent.click(screen.getByText("Record return"));
      const dialog = await screen.findByRole("dialog", { name: /Record a return from Friend/ });
      fireEvent.change(within(dialog).getByLabelText("Amount returned (₹)"), { target: { value: "2000" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record return" }));

      await waitFor(() =>
        expect(mocked.receivables.recordRepayment).toHaveBeenCalledWith("r1", expect.objectContaining({ amount: 2000, idempotencyKey: expect.any(String) })),
      );
      expect(await screen.findByRole("status")).toHaveTextContent("₹3,000 still outstanding from Friend");
    });

    it("'Full' fills in everything that is outstanding", async () => {
      render(<ReceivablesPage />);
      await screen.findByText("Friend");
      fireEvent.click(screen.getByText("Record return"));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Full" }));
      expect(within(dialog).getByLabelText("Amount returned (₹)")).toHaveValue(5000);
    });

    it("reuses the SAME idempotency key when the user retries after a failure (no double repayment)", async () => {
      const { ApiError } = jest.requireMock("@/lib/api-client");
      mocked.receivables.recordRepayment.mockRejectedValueOnce(new ApiError("Network hiccup"));
      mocked.receivables.recordRepayment.mockResolvedValueOnce({ receivable: make(), repayment: {}, duplicate: false } as any);
      render(<ReceivablesPage />);
      await screen.findByText("Friend");

      fireEvent.click(screen.getByText("Record return"));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText("Amount returned (₹)"), { target: { value: "1000" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record return" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Network hiccup");

      fireEvent.click(within(dialog).getByRole("button", { name: "Record return" }));
      await waitFor(() => expect(mocked.receivables.recordRepayment).toHaveBeenCalledTimes(2));
      const [first, second] = mocked.receivables.recordRepayment.mock.calls.map((c) => (c[1] as any).idempotencyKey);
      expect(first).toBe(second);
    });

    it("says so when the server reports a duplicate submission", async () => {
      mocked.receivables.recordRepayment.mockResolvedValue({ receivable: make(), repayment: {}, duplicate: true } as any);
      render(<ReceivablesPage />);
      await screen.findByText("Friend");
      fireEvent.click(screen.getByText("Record return"));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText("Amount returned (₹)"), { target: { value: "1000" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record return" }));
      expect(await screen.findByRole("status")).toHaveTextContent("already recorded");
    });

    it("rejects a zero amount without calling the API", async () => {
      render(<ReceivablesPage />);
      await screen.findByText("Friend");
      fireEvent.click(screen.getByText("Record return"));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Record return" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter an amount greater than zero.");
      expect(mocked.receivables.recordRepayment).not.toHaveBeenCalled();
    });

    it("does not offer 'Record return' once everything has come back", async () => {
      mocked.receivables.list.mockResolvedValue([make({ status: "FULLY_RETURNED", effectiveStatus: "FULLY_RETURNED", outstandingAmount: "0.00", returnedAmount: "5000.00" })] as any);
      render(<ReceivablesPage />);
      await screen.findByText("Friend");
      expect(screen.queryByText("Record return")).not.toBeInTheDocument();
    });
  });

  describe("history is never erased by accident", () => {
    it("hides Delete and Cancel for a receivable that has repayment history", async () => {
      mocked.receivables.list.mockResolvedValue([make({ status: "PARTIALLY_RETURNED", effectiveStatus: "PARTIALLY_RETURNED", returnedAmount: "2000.00", outstandingAmount: "3000.00" })] as any);
      render(<ReceivablesPage />);
      await screen.findByText("Friend");
      expect(screen.queryByText("Delete")).not.toBeInTheDocument();
      expect(screen.queryByText("Cancel entry")).not.toBeInTheDocument();
    });

    it("asks for confirmation before deleting, then deletes", async () => {
      mocked.receivables.remove.mockResolvedValue({ deleted: true } as any);
      render(<ReceivablesPage />);
      await screen.findByText("Friend");

      fireEvent.click(screen.getByText("Delete"));
      expect(screen.getByText("Permanently delete this receivable?")).toBeInTheDocument();
      expect(mocked.receivables.remove).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /Yes, delete/ }));
      await waitFor(() => expect(mocked.receivables.remove).toHaveBeenCalledWith("r1"));
    });

    it("cancelling explains that the record is kept but stops counting", async () => {
      mocked.receivables.cancel.mockResolvedValue(make({ status: "CANCELLED" }) as any);
      render(<ReceivablesPage />);
      await screen.findByText("Friend");
      fireEvent.click(screen.getByText("Cancel entry"));
      expect(screen.getByText(/stop counting in your totals \(the record is kept\)/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Yes, cancel it/ }));
      await waitFor(() => expect(mocked.receivables.cancel).toHaveBeenCalledWith("r1"));
    });

    it("shows the repayment history and lets a single mistaken repayment be removed after confirmation", async () => {
      mocked.receivables.list.mockResolvedValue([make({ status: "PARTIALLY_RETURNED", effectiveStatus: "PARTIALLY_RETURNED", returnedAmount: "2000.00", outstandingAmount: "3000.00" })] as any);
      mocked.receivables.get.mockResolvedValue(
        make({ repayments: [{ id: "p1", receivableId: "r1", amount: "2000.00", returnedAt: "2026-09-10T00:00:00Z", paymentMethod: "UPI", notes: null, createdAt: "" }] }) as any,
      );
      mocked.receivables.removeRepayment.mockResolvedValue(make() as any);
      render(<ReceivablesPage />);
      await screen.findByText("Friend");

      fireEvent.click(screen.getByText("History"));
      expect(await screen.findByText("+₹2,000")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Remove"));
      expect(screen.getByText(/count as outstanding again/)).toBeInTheDocument();
      expect(mocked.receivables.removeRepayment).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(mocked.receivables.removeRepayment).toHaveBeenCalledWith("r1", "p1"));
    });
  });

  it("recording money given creates a receivable (not an expense) and refreshes the list", async () => {
    mocked.receivables.create.mockResolvedValue(make() as any);
    render(<ReceivablesPage />);
    await screen.findByText("Friend");
    const before = mocked.receivables.list.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "+ Money given" }));
    const dialog = await screen.findByRole("dialog", { name: "Money given" });
    fireEvent.change(within(dialog).getByLabelText("Given to"), { target: { value: "Colleague" } });
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "2500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record money given" }));

    await waitFor(() => expect(mocked.receivables.create).toHaveBeenCalledWith(expect.objectContaining({ person: "Colleague", amount: 2500 })));
    await waitFor(() => expect(mocked.receivables.list.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByRole("status")).toHaveTextContent("not counted as an expense");
  });
});
