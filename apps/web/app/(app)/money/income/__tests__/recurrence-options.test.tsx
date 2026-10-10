import { render, screen, within } from "@testing-library/react";
import IncomePage from "../page";
import { api } from "@/lib/api-client";

jest.mock("@/lib/api-client", () => ({
  api: {
    income: { listPaged: jest.fn(), list: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn(), activateRecurrence: jest.fn(), deactivateRecurrence: jest.fn(), previewRecurrence: jest.fn(), history: jest.fn() },
  },
  ApiError: class ApiError extends Error {},
}));

describe("Income page — recurrence choices", () => {
  it("offers BIWEEKLY (a very common pay cycle) alongside the existing cadences", async () => {
    const mocked = api as jest.Mocked<typeof api>;
    (mocked.income.listPaged as jest.Mock).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 });
    (mocked.income.list as jest.Mock).mockResolvedValue([]);
    render(<IncomePage />);
    const select = (await screen.findAllByRole("combobox")).find((el) => within(el).queryByRole("option", { name: "weekly" }));
    expect(select).toBeDefined();
    const options = within(select as HTMLElement).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["weekly", "biweekly", "monthly", "quarterly", "yearly"]));
  });
});
