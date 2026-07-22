import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BusinessPage from "../page";
import { api } from "@/lib/api-client";

jest.mock("@/lib/api-client", () => ({
  api: {
    business: {
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      summary: jest.fn(),
      transactions: jest.fn(),
      obligations: jest.fn(),
      updateTransaction: jest.fn(),
      removeTransaction: jest.fn(),
      updateObligation: jest.fn(),
      removeObligation: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));

const mockedApi = api as jest.Mocked<typeof api>;

const business = {
  id: "b1",
  userId: "u1",
  name: "Sunil Tailor & Jewellery",
  description: "Family business",
  entityType: "SOLE_PROPRIETORSHIP",
  currency: "INR",
  startedAt: "2018-04-01T00:00:00.000Z",
  ownershipPercent: "100",
};

const summary = {
  month: "2026-07",
  revenue: "165000",
  expenses: "58000",
  profit: "107000",
  trend: [{ month: "2026-07", profit: "107000" }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedApi.business.list.mockResolvedValue([business] as any);
  mockedApi.business.summary.mockResolvedValue(summary as any);
  mockedApi.business.transactions.mockResolvedValue([]);
  mockedApi.business.obligations.mockResolvedValue([]);
});

describe("BusinessPage edit flow", () => {
  it("lets the user edit and save a business's metadata without deleting/recreating it", async () => {
    mockedApi.business.update.mockResolvedValue({ ...business, name: "Renamed Studio" } as any);

    render(<BusinessPage />);

    // wait for the business + its data to load
    await screen.findByText("Sunil Tailor & Jewellery");
    await waitFor(() => expect(mockedApi.business.summary).toHaveBeenCalledWith("b1"));

    fireEvent.click(screen.getByText("Edit"));

    const nameInput = screen.getByDisplayValue("Sunil Tailor & Jewellery");
    fireEvent.change(nameInput, { target: { value: "Renamed Studio" } });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(mockedApi.business.update).toHaveBeenCalledWith(
        "b1",
        expect.objectContaining({ name: "Renamed Studio" }),
      ),
    );
    // No delete call anywhere in this flow — editing must not fall back to delete+recreate.
    expect(mockedApi.business.create).not.toHaveBeenCalled();
  });

  it("shows an error instead of crashing when loading businesses fails", async () => {
    mockedApi.business.list.mockRejectedValue(new Error("network down"));

    render(<BusinessPage />);

    expect(await screen.findByText(/add a business above/i)).toBeInTheDocument();
  });
});
