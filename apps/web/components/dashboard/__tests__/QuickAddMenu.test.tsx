import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/lib/api-client";
import { QuickAddMenu } from "../QuickAddMenu";

jest.mock("@/lib/api-client", () => ({
  api: { expenses: { categories: jest.fn().mockResolvedValue([]), quickCreate: jest.fn() } },
  ApiError: class extends Error {},
}));

describe("QuickAddMenu", () => {
  it("opens a menu of every kind of entry and closes on Escape, returning focus", () => {
    render(<QuickAddMenu />);
    const button = screen.getByRole("button", { name: /add/i });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.getByRole("menu", { name: "Quick add" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add expense" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add income" })).toHaveAttribute("href", "/money/income");
    expect(screen.getByRole("menuitem", { name: "Add investment" })).toHaveAttribute("href", "/money/investments");
    expect(screen.getByRole("menuitem", { name: "Add to emergency fund" })).toHaveAttribute("href", "/money/emergency-fund");
    expect(screen.getByRole("menuitem", { name: "Lend money (receivable)" })).toHaveAttribute("href", "/money/receivables");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("'Add expense' opens the quick-expense dialog", async () => {
    render(<QuickAddMenu />);
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add expense" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // The categories are fetched once the dialog is asked for, not on every page load.
    await waitFor(() => expect(api.expenses.categories).toHaveBeenCalledTimes(1));
  });
});
