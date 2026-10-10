import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import EmergencyFundPage from "../page";
import { api } from "@/lib/api-client";
import { onFinancialChange } from "@/lib/financial-events";
import { localDateString } from "@/lib/dates";
import { categories, ledgerRow, overview } from "@/__fixtures__/emergency";

jest.mock("@/lib/api-client", () => ({
  api: {
    emergencyFund: { overview: jest.fn(), ledger: jest.fn(), create: jest.fn(), use: jest.fn(), setPlan: jest.fn(), remove: jest.fn() },
    expenses: { categories: jest.fn() },
  },
  ApiError: class ApiError extends Error {},
}));

// Charts need real layout, which jsdom lacks; their data comes from the same overview asserted below.
jest.mock("@/components/emergency/EmergencyCharts", () => ({
  BalanceTrendChart: () => <div data-testid="balance-chart" />,
  ContributionVsUseChart: () => <div data-testid="flow-chart" />,
}));

const ef = api.emergencyFund as jest.Mocked<typeof api.emergencyFund>;
const mocked = api as jest.Mocked<typeof api>;

const history = [
  ledgerRow({ id: "e3", type: "WITHDRAWAL", amount: "3000.00", effect: "-3000.00", balanceAfter: "82000.00", reason: "Medical emergency", occurredAt: "2026-09-10T00:00:00Z" }),
  ledgerRow({ id: "e1", balanceAfter: "85000.00" }),
];

beforeEach(() => {
  jest.clearAllMocks();
  ef.overview.mockResolvedValue(overview());
  ef.ledger.mockResolvedValue(history);
  mocked.expenses.categories.mockResolvedValue(categories());
});

describe("Emergency fund page — the numbers (spec Parts 20–23)", () => {
  it("Part 21: ₹82,000 vs a 6-month ₹1,50,000 target → ₹68,000 to go, 54.7%, 3.28 months", async () => {
    render(<EmergencyFundPage />);
    expect(await screen.findByText("₹82,000", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("₹1,50,000")).toBeInTheDocument();
    expect(screen.getByText("6 months of essential expenses")).toBeInTheDocument();
    expect(screen.getByText("54.7%")).toBeInTheDocument();
    expect(screen.getByText("₹68,000 to go")).toBeInTheDocument();
    expect(screen.getByText("3.28 months")).toBeInTheDocument();
  });

  it("labels each figure by what kind of fact it is: ACTUAL balance, TARGET target, ESTIMATED plan", async () => {
    render(<EmergencyFundPage />);
    await screen.findByText("3.28 months");
    const card = (label: string) => screen.getAllByText(label)[0].closest(".panel") as HTMLElement;
    expect(within(card("In your fund")).getByText("ACTUAL")).toBeInTheDocument();
    expect(within(card("Target")).getByText("TARGET")).toBeInTheDocument();
    expect(within(card("Planned each month")).getByText("ESTIMATED")).toBeInTheDocument();
  });

  it("progress is exposed to assistive technology, not just drawn", async () => {
    render(<EmergencyFundPage />);
    const bar = await screen.findByRole("progressbar", { name: "Progress towards your emergency fund target" });
    expect(bar).toHaveAttribute("aria-valuenow", "55");
    expect(bar).toHaveAttribute("aria-valuetext", "54.7%");
  });

  it("shows contributions, withdrawals and the last of each", async () => {
    render(<EmergencyFundPage />);
    await screen.findByText("3.28 months");
    expect(screen.getAllByText("₹85,000", { selector: "p" })).toHaveLength(2); // added this year, and total added
    expect(screen.getByText("₹3,000", { selector: "p" })).toBeInTheDocument(); // total used
    expect(screen.getByText(/last on 1 Oct 2026: ₹7,000/)).toBeInTheDocument();
    expect(screen.getByText(/last on 10 Sept? 2026: ₹3,000/)).toBeInTheDocument();
    expect(screen.getByText("₹7,000 this month")).toBeInTheDocument();
  });

  it("flags LOW cover in words (and amber), never by colour alone", async () => {
    ef.overview.mockResolvedValue(overview({ coverage: { months: "1.50", avgMonthlyEssentialExpenses: "25000.00", monthsOfData: 3 } }));
    render(<EmergencyFundPage />);
    expect(await screen.findByText("Less than 3 months of essential expenses covered")).toBeInTheDocument();
    expect(screen.getByText("1.50 months")).toHaveClass("text-marigold-600");
  });

  it("explains missing history instead of showing a zero", async () => {
    ef.overview.mockResolvedValue(
      overview({
        coverage: { months: null, avgMonthlyEssentialExpenses: "0.00", monthsOfData: 0 },
        target: { basis: "TARGET", mode: "MONTHS", amount: null, months: "6", needsExpenseHistory: true },
        progress: { percent: null, remaining: null, reached: false },
      }),
    );
    render(<EmergencyFundPage />);
    expect(await screen.findByText(/6 months of essential expenses — needs a few months of spending history/)).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("says 'Target reached' once it is", async () => {
    ef.overview.mockResolvedValue(overview({ balance: "160000.00", progress: { percent: 106.7, remaining: "0.00", reached: true }, plan: { ...overview().plan, requiredMonthly: "0.00", monthsToTargetAtPlan: 0, estimatedFinishDate: null } }));
    render(<EmergencyFundPage />);
    expect(await screen.findByText("Target reached")).toBeInTheDocument();
    expect(screen.getByText("You have already reached it.")).toBeInTheDocument();
  });

  it("shows no target and invites setting one when none exists", async () => {
    ef.overview.mockResolvedValue(
      overview({
        target: { basis: "TARGET", mode: null, amount: null, months: null, needsExpenseHistory: false },
        progress: { percent: null, remaining: null, reached: false },
        plan: { basis: "ESTIMATED", monthlyContribution: null, targetDate: null, requiredMonthly: null, requiredWeekly: null, monthsToTargetAtPlan: null, estimatedFinishDate: null },
      }),
    );
    render(<EmergencyFundPage />);
    expect(await screen.findByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set a target" })).toBeInTheDocument();
    expect(screen.getByText(/Choose a target — a number of months/)).toBeInTheDocument();
  });

  it("an empty fund says how to start", async () => {
    ef.overview.mockResolvedValue(overview({ balance: "0.00", entryCount: 0 }));
    ef.ledger.mockResolvedValue([]);
    render(<EmergencyFundPage />);
    expect(await screen.findByText(/Use “\+ Add money” to start your fund/)).toBeInTheDocument();
    expect(screen.getByText("nothing added yet")).toBeInTheDocument();
  });

  it("reports a load failure", async () => {
    ef.overview.mockRejectedValue(new Error("down"));
    render(<EmergencyFundPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load your emergency fund.");
  });
});

describe("Emergency fund page — the contribution plan is an estimate, not advice", () => {
  it("shows what it would take each month and week, and how long at the planned amount", async () => {
    render(<EmergencyFundPage />);
    const card = (await screen.findByText("Target and plan")).closest(".panel, section, div") as HTMLElement;
    expect(await screen.findByText(/About/)).toHaveTextContent("About ₹11,333 a month (or ₹2,615 a week).");
    expect(screen.getByText(/At ₹10,000 a month you would reach it in about/)).toHaveTextContent("7 months");
    expect(screen.getByText(/not a recommendation/)).toBeInTheDocument();
    expect(card).toBeTruthy();
  });

  it("a target date that has passed explains there is no time left to plan with", async () => {
    ef.overview.mockResolvedValue(overview({ plan: { ...overview().plan, requiredMonthly: null, requiredWeekly: null, monthsToTargetAtPlan: null, estimatedFinishDate: null } }));
    render(<EmergencyFundPage />);
    expect(await screen.findByText(/today or has passed/)).toBeInTheDocument();
  });
});

describe("Emergency fund page — history", () => {
  it("lists each entry as Added / Used with the balance after it, signed", async () => {
    render(<EmergencyFundPage />);
    await screen.findByText("3.28 months");
    const used = screen.getByText("Used").closest("li") as HTMLElement;
    expect(used).toHaveTextContent("Medical emergency");
    expect(used).toHaveTextContent("−₹3,000");
    expect(used).toHaveTextContent("balance ₹82,000");
    const added = screen.getByText("Added").closest("li") as HTMLElement;
    expect(added).toHaveTextContent("+₹7,000");
    expect(added).toHaveTextContent("balance ₹85,000");
  });

  it("asks before deleting, then deletes and refreshes", async () => {
    ef.remove.mockResolvedValue({ deleted: true });
    render(<EmergencyFundPage />);
    await screen.findByText("3.28 months");
    const before = ef.overview.mock.calls.length;
    fireEvent.click(screen.getAllByText("Remove")[1]);
    expect(screen.getByText("Delete this entry?")).toBeInTheDocument();
    expect(ef.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(ef.remove).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(ef.overview.mock.calls.length).toBeGreaterThan(before));
  });

  it("shows the server's reason when a delete would make the fund negative (Part 52)", async () => {
    const { ApiError } = jest.requireMock("@/lib/api-client");
    ef.remove.mockRejectedValue(new ApiError("Deleting this entry would make the reserve negative (-3000.00). Remove or correct the later withdrawals first."));
    render(<EmergencyFundPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getAllByText("Remove")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("would make the reserve negative");
  });
});

describe("Emergency fund page — Add money", () => {
  const openAdd = async () => {
    render(<EmergencyFundPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "+ Add money" }));
    return screen.findByRole("dialog", { name: /Add money/ });
  };

  it("Part 59: ₹7,000 added → an ALLOCATE entry, described as saved (not spent), and every page is told", async () => {
    ef.create.mockResolvedValue({} as any);
    const seen: string[] = [];
    const off = onFinancialChange((k) => seen.push(k));
    const dialog = await openAdd();
    expect(within(dialog).getByText(/never counts as an expense/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "7000" } });
    fireEvent.change(within(dialog).getByLabelText("Source (optional)"), { target: { value: "Bonus" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add money" }));

    await waitFor(() => expect(ef.create).toHaveBeenCalledWith({ type: "ALLOCATE", amount: 7000, occurredAt: localDateString(), reason: "Bonus", notes: undefined }));
    expect(await screen.findByRole("status")).toHaveTextContent("not counted as an expense");
    expect(seen).toContain("emergency");
    off();
  });

  it("suggests the usual sources", async () => {
    const dialog = await openAdd();
    const list = dialog.querySelector("datalist")!;
    expect(Array.from(list.querySelectorAll("option")).map((o) => o.getAttribute("value"))).toEqual(["Monthly contribution", "Bonus", "Extra savings", "Salary allocation"]);
  });

  it("rejects a zero amount without calling the API", async () => {
    const dialog = await openAdd();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add money" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter an amount greater than zero.");
    expect(ef.create).not.toHaveBeenCalled();
  });
});

describe("Emergency fund page — Use money (Part 24)", () => {
  const openUse = async () => {
    render(<EmergencyFundPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "− Use money" }));
    return screen.findByRole("dialog", { name: /Use money/ });
  };

  it("a medical bill paid from the fund: one request records the withdrawal AND the expense, once", async () => {
    ef.use.mockResolvedValue({ entry: {} as any, expense: {} as any });
    const seen: string[] = [];
    const off = onFinancialChange((k) => seen.push(k));
    const dialog = await openUse();
    expect(within(dialog).getByRole("checkbox")).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "3000" } });
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), { target: { value: "Medical emergency" } });
    fireEvent.change(within(dialog).getByLabelText("What was it for?"), { target: { value: "med" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use money" }));

    await waitFor(() =>
      expect(ef.use).toHaveBeenCalledWith({ amount: 3000, occurredAt: localDateString(), reason: "Medical emergency", notes: undefined, expense: { categoryId: "med", merchant: "Medical emergency" } }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("recorded once as an expense");
    expect(seen).toEqual(expect.arrayContaining(["emergency", "expense"]));
    off();
  });

  it("if the money was not spent, no expense is sent and the message says so", async () => {
    ef.use.mockResolvedValue({ entry: {} as any, expense: null });
    const dialog = await openUse();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(within(dialog).queryByLabelText("What was it for?")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "1000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use money" }));
    await waitFor(() => expect(ef.use).toHaveBeenCalled());
    expect(ef.use.mock.calls[0][0]).not.toHaveProperty("expense");
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing was recorded as spending");
  });

  it("never offers a savings category for the expense", async () => {
    const dialog = await openUse();
    const select = within(dialog).getByLabelText("What was it for?");
    expect(within(select).getByRole("option", { name: "Medical" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: "SIP Investment" })).not.toBeInTheDocument();
  });

  it("cannot take out more than is in the fund — blocked before any request", async () => {
    const dialog = await openUse();
    expect(within(dialog).getByText(/You cannot take out more than this/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "90000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use money" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("at most ₹82,000");
    expect(ef.use).not.toHaveBeenCalled();
  });

  it("surfaces the server's refusal (e.g. a race that overdrew the fund)", async () => {
    const { ApiError } = jest.requireMock("@/lib/api-client");
    ef.use.mockRejectedValue(new ApiError("Cannot take 3000.00 out of the reserve; Emergency Cash is 2000.00."));
    const dialog = await openUse();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "3000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use money" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Emergency Cash is 2000.00");
  });

  it("suggests the usual reasons", async () => {
    const dialog = await openUse();
    const list = dialog.querySelector("datalist")!;
    expect(Array.from(list.querySelectorAll("option")).map((o) => o.getAttribute("value"))).toEqual(["Medical emergency", "Job loss", "Urgent repair", "Family emergency"]);
  });
});

describe("Emergency fund page — target and plan dialog", () => {
  const openPlan = async () => {
    render(<EmergencyFundPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return screen.findByRole("dialog", { name: "Target and plan" });
  };

  it("starts from the current target and plan", async () => {
    const dialog = await openPlan();
    expect(within(dialog).getByLabelText("Months of expenses")).toBeChecked();
    expect(within(dialog).getByLabelText("Months of essential expenses to keep")).toHaveValue(6);
    expect(within(dialog).getByLabelText("I plan to add each month (₹, optional)")).toHaveValue(10000);
    expect(within(dialog).getByLabelText("Reach the target by (optional)")).toHaveValue("2027-04-03");
  });

  it("saves months of expenses as the target (never an amount alongside it)", async () => {
    ef.setPlan.mockResolvedValue({});
    const dialog = await openPlan();
    fireEvent.change(within(dialog).getByLabelText("Months of essential expenses to keep"), { target: { value: "9" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ef.setPlan).toHaveBeenCalledWith({ targetMonths: 9, monthlyContribution: 10000, targetDate: "2027-04-03" }));
    expect(ef.setPlan.mock.calls[0][0]).not.toHaveProperty("targetAmount");
  });

  it("switching to a fixed amount sends only the amount", async () => {
    ef.setPlan.mockResolvedValue({});
    const dialog = await openPlan();
    fireEvent.click(within(dialog).getByLabelText("A fixed amount"));
    fireEvent.change(within(dialog).getByLabelText("Target amount (₹)"), { target: { value: "200000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ef.setPlan).toHaveBeenCalledWith(expect.objectContaining({ targetAmount: 200000 })));
    expect(ef.setPlan.mock.calls[0][0]).not.toHaveProperty("targetMonths");
  });

  it("'No target' clears both, and emptied optional fields are cleared (null), not left alone", async () => {
    ef.setPlan.mockResolvedValue({});
    const dialog = await openPlan();
    fireEvent.click(within(dialog).getByLabelText("No target"));
    fireEvent.change(within(dialog).getByLabelText("I plan to add each month (₹, optional)"), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText("Reach the target by (optional)"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ef.setPlan).toHaveBeenCalledWith({ targetAmount: null, targetMonths: null, monthlyContribution: null, targetDate: null }));
  });

  it.each([
    ["months out of range", "Months of essential expenses to keep", "100", "Choose between 0.5 and 60 months."],
    ["a negative monthly contribution", "I plan to add each month (₹, optional)", "-5", "greater than zero, or leave it empty"],
  ])("rejects %s without calling the API", async (_n, label, value, message) => {
    const dialog = await openPlan();
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(ef.setPlan).not.toHaveBeenCalled();
  });

  it("rejects a target date in the past", async () => {
    const dialog = await openPlan();
    fireEvent.change(within(dialog).getByLabelText("Reach the target by (optional)"), { target: { value: "2020-01-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("cannot be in the past");
    expect(ef.setPlan).not.toHaveBeenCalled();
  });
});
