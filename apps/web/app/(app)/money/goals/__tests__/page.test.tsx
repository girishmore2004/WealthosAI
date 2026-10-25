import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import MoneyGoalsPage from "../page";
import { api } from "@/lib/api-client";
import { onFinancialChange } from "@/lib/financial-events";
import { localDateString } from "@/lib/dates";
import { RETIREMENT_RULES, categories, fund, houseFund, houseOverview, ledgerRow, overview } from "@/__fixtures__/goal-funds";

let search = "goal=g-ef";
const replace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search),
}));

jest.mock("@/lib/api-client", () => ({
  api: {
    goalFunds: { list: jest.fn(), overview: jest.fn(), ledger: jest.fn(), add: jest.fn(), use: jest.fn(), reallocate: jest.fn(), setPlan: jest.fn(), removeEntry: jest.fn() },
    goals: { create: jest.fn(), remove: jest.fn(), restore: jest.fn() },
    expenses: { categories: jest.fn() },
  },
  ApiError: class ApiError extends Error {},
}));

// Charts need real layout, which jsdom lacks; their data comes from the same overview asserted below.
jest.mock("@/components/goals/GoalFundCharts", () => ({
  BalanceTrendChart: () => <div data-testid="balance-chart" />,
  ContributionVsUseChart: () => <div data-testid="flow-chart" />,
}));

const gf = api.goalFunds as jest.Mocked<typeof api.goalFunds>;
const goals = api.goals as jest.Mocked<typeof api.goals>;
const mocked = api as jest.Mocked<typeof api>;

const history = [
  ledgerRow({ id: "e3", type: "WITHDRAWAL", amount: "3000.00", effect: "-3000.00", balanceAfter: "82000.00", reason: "Medical emergency", occurredAt: "2026-09-10T00:00:00Z" }),
  ledgerRow({ id: "e1", balanceAfter: "85000.00" }),
];

beforeEach(() => {
  jest.clearAllMocks();
  search = "goal=g-ef";
  gf.list.mockResolvedValue([fund(), houseFund()]);
  gf.overview.mockImplementation(async (id: string) => (id === "g-house" ? houseOverview() : overview()));
  gf.ledger.mockResolvedValue(history);
  mocked.expenses.categories.mockResolvedValue(categories());
});

// ---------------------------------------------------------------------------------------------------------
// Emergency fund parity — everything the old Emergency fund page did, now on the emergency goal here.
// ---------------------------------------------------------------------------------------------------------
describe("Money → Goals — emergency fund parity: the numbers (spec Parts 20–23)", () => {
  it("Part 21: ₹82,000 vs a 6-month ₹1,50,000 target → ₹68,000 to go, 54.7%, 3.28 months", async () => {
    render(<MoneyGoalsPage />);
    expect(await screen.findByText("₹82,000", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("₹1,50,000")).toBeInTheDocument();
    expect(screen.getByText("6 months of essential expenses")).toBeInTheDocument();
    expect(screen.getByText("54.7%")).toBeInTheDocument();
    expect(screen.getByText("₹68,000 to go")).toBeInTheDocument();
    expect(screen.getByText("3.28 months")).toBeInTheDocument();
  });

  it("labels each figure by what kind of fact it is: ACTUAL balance, TARGET target, ESTIMATED plan", async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    const card = (label: string) => screen.getAllByText(label)[0].closest(".panel") as HTMLElement;
    expect(within(card("In your fund")).getByText("ACTUAL")).toBeInTheDocument();
    expect(within(card("Target")).getByText("TARGET")).toBeInTheDocument();
    expect(within(card("Planned each month")).getByText("ESTIMATED")).toBeInTheDocument();
  });

  it("progress is exposed to assistive technology, not just drawn", async () => {
    render(<MoneyGoalsPage />);
    const bar = await screen.findByRole("progressbar", { name: "Progress towards your Emergency fund target" });
    expect(bar).toHaveAttribute("aria-valuenow", "55");
    expect(bar).toHaveAttribute("aria-valuetext", "54.7%");
  });

  it("shows contributions, withdrawals and the last of each", async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    expect(screen.getAllByText("₹85,000", { selector: "p" })).toHaveLength(2); // added this year, and total added
    expect(screen.getByText("₹3,000", { selector: "p" })).toBeInTheDocument(); // total used
    expect(screen.getByText(/last on 1 Oct 2026: ₹7,000/)).toBeInTheDocument();
    expect(screen.getByText(/last on 10 Sept? 2026: ₹3,000/)).toBeInTheDocument();
    expect(screen.getByText("₹7,000 this month")).toBeInTheDocument();
  });

  it("flags LOW cover in words (and amber), never by colour alone", async () => {
    gf.overview.mockResolvedValue(overview({ coverage: { months: "1.50", avgMonthlyEssentialExpenses: "25000.00", monthsOfData: 3 } }));
    render(<MoneyGoalsPage />);
    expect(await screen.findByText("Less than 3 months of essential expenses covered")).toBeInTheDocument();
    expect(screen.getByText("1.50 months")).toHaveClass("text-marigold-600");
  });

  it("explains missing history instead of showing a zero", async () => {
    gf.overview.mockResolvedValue(
      overview({
        coverage: { months: null, avgMonthlyEssentialExpenses: "0.00", monthsOfData: 0 },
        target: { basis: "TARGET", mode: "MONTHS", amount: null, months: "6", needsExpenseHistory: true },
        progress: { percent: null, remaining: null, reached: false },
      }),
    );
    render(<MoneyGoalsPage />);
    expect(await screen.findByText(/6 months of essential expenses — needs a few months of spending history/)).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("says 'Target reached' once it is", async () => {
    gf.overview.mockResolvedValue(overview({ balance: "160000.00", progress: { percent: 106.7, remaining: "0.00", reached: true }, plan: { ...overview().plan, requiredMonthly: "0.00", monthsToTargetAtPlan: 0, estimatedFinishDate: null } }));
    render(<MoneyGoalsPage />);
    expect(await screen.findByText("Target reached")).toBeInTheDocument();
    expect(screen.getByText("You have already reached it.")).toBeInTheDocument();
  });

  it("shows no target and invites setting one when none exists", async () => {
    gf.overview.mockResolvedValue(
      overview({
        target: { basis: "TARGET", mode: null, amount: null, months: null, needsExpenseHistory: false },
        progress: { percent: null, remaining: null, reached: false },
        plan: { basis: "ESTIMATED", monthlyContribution: null, targetDate: null, requiredMonthly: null, requiredWeekly: null, monthsToTargetAtPlan: null, estimatedFinishDate: null },
      }),
    );
    render(<MoneyGoalsPage />);
    expect(await screen.findByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set a target" })).toBeInTheDocument();
    expect(screen.getByText(/Choose a target — a number of months/)).toBeInTheDocument();
  });

  it("an empty fund says how to start", async () => {
    gf.overview.mockResolvedValue(overview({ balance: "0.00", entryCount: 0 }));
    gf.ledger.mockResolvedValue([]);
    render(<MoneyGoalsPage />);
    expect(await screen.findByText(/Use “\+ Add money” to start/)).toBeInTheDocument();
    expect(screen.getByText("nothing added yet")).toBeInTheDocument();
  });

  it("reports a load failure", async () => {
    gf.overview.mockRejectedValue(new Error("down"));
    render(<MoneyGoalsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this goal.");
  });
});

describe("Money → Goals — the contribution plan is an estimate, not advice", () => {
  it("shows what it would take each month and week, and how long at the planned amount", async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("Target and plan");
    expect(await screen.findByText(/About/)).toHaveTextContent("About ₹11,333 a month (or ₹2,615 a week).");
    expect(screen.getByText(/At ₹10,000 a month you would reach it in about/)).toHaveTextContent("7 months");
    expect(screen.getByText(/not a recommendation/)).toBeInTheDocument();
  });

  it("a target date that has passed explains there is no time left to plan with", async () => {
    gf.overview.mockResolvedValue(overview({ plan: { ...overview().plan, requiredMonthly: null, requiredWeekly: null, monthsToTargetAtPlan: null, estimatedFinishDate: null } }));
    render(<MoneyGoalsPage />);
    expect(await screen.findByText(/today or has passed/)).toBeInTheDocument();
  });

  it("shows the same on-track status the Goals overview shows", async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("Target and plan");
    expect(screen.getByText("At risk")).toBeInTheDocument();
  });
});

describe("Money → Goals — history", () => {
  it("lists each entry as Added / Used with the balance after it, signed", async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    const used = screen.getByText("Used").closest("li") as HTMLElement;
    expect(used).toHaveTextContent("Medical emergency");
    expect(used).toHaveTextContent("−₹3,000");
    expect(used).toHaveTextContent("balance ₹82,000");
    const added = screen.getByText("Added").closest("li") as HTMLElement;
    expect(added).toHaveTextContent("+₹7,000");
    expect(added).toHaveTextContent("balance ₹85,000");
  });

  it("names system entries plainly: opening balance, moved in / out, returned to cash", async () => {
    gf.ledger.mockResolvedValue([
      ledgerRow({ id: "r1", type: "TRANSFER_OUT", effect: "-4000.00", amount: "4000.00", origin: "REALLOCATION", reason: "Moved to House" }),
      ledgerRow({ id: "r2", type: "TRANSFER_IN", origin: "REALLOCATION", reason: "Moved from Car" }),
      ledgerRow({ id: "r3", origin: "OPENING_BALANCE", reason: null }),
      ledgerRow({ id: "r4", type: "RELEASE", effect: "-100.00", amount: "100.00", origin: "GOAL_CLOSED" }),
    ]);
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    expect(screen.getByText("Moved out")).toBeInTheDocument();
    expect(screen.getByText("Moved in")).toBeInTheDocument();
    expect(screen.getByText("Opening balance")).toBeInTheDocument();
    expect(screen.getByText("Returned to cash")).toBeInTheDocument();
  });

  it("asks before deleting, then deletes THIS goal's entry and refreshes", async () => {
    gf.removeEntry.mockResolvedValue({ deleted: true });
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    const before = gf.overview.mock.calls.length;
    fireEvent.click(screen.getAllByText("Remove")[1]);
    expect(screen.getByText("Delete this entry?")).toBeInTheDocument();
    expect(gf.removeEntry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(gf.removeEntry).toHaveBeenCalledWith("g-ef", "e1"));
    await waitFor(() => expect(gf.overview.mock.calls.length).toBeGreaterThan(before));
  });

  it("deleting one half of a move says both halves are undone", async () => {
    gf.ledger.mockResolvedValue([ledgerRow({ id: "r1", type: "TRANSFER_OUT", effect: "-4000.00", amount: "4000.00", origin: "REALLOCATION" })]);
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByText("Remove"));
    expect(screen.getByText("Undo this move? Both goals are put back.")).toBeInTheDocument();
  });

  it("tells the user when deleting a spend entry kept its expense", async () => {
    gf.removeEntry.mockResolvedValue({ deleted: true, keptExpenseId: "x1" });
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getAllByText("Remove")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("status")).toHaveTextContent("The expense it recorded was kept");
  });

  it("shows the server's reason when a delete would make a balance negative (Part 52)", async () => {
    const { ApiError } = jest.requireMock("@/lib/api-client");
    gf.removeEntry.mockRejectedValue(new ApiError("Deleting this would leave your emergency fund negative (-3000.00). Remove or correct the later withdrawals first."));
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getAllByText("Remove")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("negative");
  });
});

describe("Money → Goals — Add money", () => {
  const openAdd = async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "+ Add money" }));
    return screen.findByRole("dialog", { name: /Add money/ });
  };

  it("Part 59: ₹7,000 added → an ALLOCATE on THIS goal with a request id, described as saved (not spent), and every page is told", async () => {
    gf.add.mockResolvedValue({});
    const seen: string[] = [];
    const off = onFinancialChange((k) => seen.push(k));
    const dialog = await openAdd();
    expect(within(dialog).getByText(/never counts as an expense/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "7000" } });
    fireEvent.change(within(dialog).getByLabelText("Source (optional)"), { target: { value: "Bonus" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add money" }));

    await waitFor(() =>
      expect(gf.add).toHaveBeenCalledWith("g-ef", { type: "ALLOCATE", amount: 7000, occurredAt: localDateString(), reason: "Bonus", notes: undefined, requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("not counted as an expense");
    expect(seen).toEqual(expect.arrayContaining(["goal", "emergency"]));
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
    expect(gf.add).not.toHaveBeenCalled();
  });

  it("a retry after a failure reuses the same request id, so a duplicate can never be written twice", async () => {
    gf.add.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({});
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add money" }));
    await within(dialog).findByRole("alert");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add money" }));
    await waitFor(() => expect(gf.add).toHaveBeenCalledTimes(2));
    expect(gf.add.mock.calls[0][1].requestId).toBe(gf.add.mock.calls[1][1].requestId);
  });
});

describe("Money → Goals — Use money (Part 24)", () => {
  const openUse = async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "− Use money" }));
    return screen.findByRole("dialog", { name: /Use money/ });
  };

  it("a medical bill paid from the fund: one request records the withdrawal AND the expense, once", async () => {
    gf.use.mockResolvedValue({ entry: {} as any, expense: {} as any });
    const seen: string[] = [];
    const off = onFinancialChange((k) => seen.push(k));
    const dialog = await openUse();
    expect(within(dialog).getByRole("checkbox")).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "3000" } });
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), { target: { value: "Medical emergency" } });
    fireEvent.change(within(dialog).getByLabelText("What was it for?"), { target: { value: "med" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use money" }));

    await waitFor(() =>
      expect(gf.use).toHaveBeenCalledWith("g-ef", {
        amount: 3000,
        occurredAt: localDateString(),
        reason: "Medical emergency",
        notes: undefined,
        spend: { mode: "EXPENSE", categoryId: "med", merchant: "Medical emergency" },
        requestId: expect.any(String),
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("recorded once as an expense");
    expect(seen).toEqual(expect.arrayContaining(["goal", "emergency", "expense"]));
    off();
  });

  it("if the money was not spent, no spend is sent and the message says so", async () => {
    gf.use.mockResolvedValue({ entry: {} as any, expense: null });
    const dialog = await openUse();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(within(dialog).queryByLabelText("What was it for?")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "1000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use money" }));
    await waitFor(() => expect(gf.use).toHaveBeenCalled());
    expect(gf.use.mock.calls[0][1]).not.toHaveProperty("spend");
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
    expect(gf.use).not.toHaveBeenCalled();
  });

  it("surfaces the server's refusal (e.g. a race that overdrew the fund)", async () => {
    const { ApiError } = jest.requireMock("@/lib/api-client");
    gf.use.mockRejectedValue(new ApiError("Cannot take 3000.00 out of the reserve; Emergency Cash is 2000.00."));
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

describe("Money → Goals — target and plan dialog (emergency fund: months or amount)", () => {
  const openPlan = async () => {
    render(<MoneyGoalsPage />);
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
    gf.setPlan.mockResolvedValue({});
    const dialog = await openPlan();
    fireEvent.change(within(dialog).getByLabelText("Months of essential expenses to keep"), { target: { value: "9" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gf.setPlan).toHaveBeenCalledWith("g-ef", { targetMonths: 9, monthlyContribution: 10000, targetDate: "2027-04-03" }));
    expect(gf.setPlan.mock.calls[0][1]).not.toHaveProperty("targetAmount");
  });

  it("switching to a fixed amount sends only the amount", async () => {
    gf.setPlan.mockResolvedValue({});
    const dialog = await openPlan();
    fireEvent.click(within(dialog).getByLabelText("A fixed amount"));
    fireEvent.change(within(dialog).getByLabelText("Target amount (₹)"), { target: { value: "200000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gf.setPlan).toHaveBeenCalledWith("g-ef", expect.objectContaining({ targetAmount: 200000 })));
    expect(gf.setPlan.mock.calls[0][1]).not.toHaveProperty("targetMonths");
  });

  it("'No target' clears both, and emptied optional fields are cleared (null), not left alone", async () => {
    gf.setPlan.mockResolvedValue({});
    const dialog = await openPlan();
    fireEvent.click(within(dialog).getByLabelText("No target"));
    fireEvent.change(within(dialog).getByLabelText("I plan to add each month (₹, optional)"), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText("Reach the target by (optional)"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gf.setPlan).toHaveBeenCalledWith("g-ef", { targetAmount: null, targetMonths: null, monthlyContribution: null, targetDate: null }));
  });

  it.each([
    ["months out of range", "Months of essential expenses to keep", "100", "Choose between 0.5 and 60 months."],
    ["a negative monthly contribution", "I plan to add each month (₹, optional)", "-5", "greater than zero, or leave it empty"],
  ])("rejects %s without calling the API", async (_n, label, value, message) => {
    const dialog = await openPlan();
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(gf.setPlan).not.toHaveBeenCalled();
  });

  it("rejects a target date in the past", async () => {
    const dialog = await openPlan();
    fireEvent.change(within(dialog).getByLabelText("Reach the target by (optional)"), { target: { value: "2020-01-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("cannot be in the past");
    expect(gf.setPlan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Every goal, not just the emergency fund.
// ---------------------------------------------------------------------------------------------------------
describe("Money → Goals — the goal selector", () => {
  it("lists every goal with its own balance and progress, and opens the selected one", async () => {
    search = "goal=g-house";
    render(<MoneyGoalsPage />);
    expect(await screen.findByRole("heading", { name: "House" })).toBeInTheDocument();
    expect(gf.overview).toHaveBeenCalledWith("g-house");
    expect(gf.ledger).toHaveBeenCalledWith("g-house");
    const nav = screen.getByRole("navigation", { name: "Your goals" });
    expect(within(nav).getByRole("button", { name: /Emergency fund/ })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /House/ })).toHaveAttribute("aria-current", "true");
    expect(within(nav).getByText("₹82,000", { selector: "span" })).toBeInTheDocument();
    expect(within(nav).getByText("₹1,05,000", { selector: "span" })).toBeInTheDocument();
  });

  it("choosing a goal changes the URL, so a goal can be linked to and survives a reload", async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Your goals" })).getByRole("button", { name: /House/ }));
    expect(replace).toHaveBeenCalledWith("/money/goals?goal=g-house", { scroll: false });
  });

  it("?goal=emergency opens the emergency fund (old links and the Home shortcuts)", async () => {
    search = "goal=emergency";
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    expect(gf.overview).toHaveBeenCalledWith("g-ef");
  });

  it("with no ?goal it opens the first goal", async () => {
    search = "";
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    expect(gf.overview).toHaveBeenCalledWith("g-ef");
  });

  it("with no goals it invites creating the first one", async () => {
    gf.list.mockResolvedValue([]);
    render(<MoneyGoalsPage />);
    expect(await screen.findByText("No goals yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create your first goal" })).toBeInTheDocument();
  });
});

describe("Money → Goals — a goal that is not the emergency fund", () => {
  beforeEach(() => {
    search = "goal=g-house";
  });

  it("has no coverage figure; it shows what is still to save instead, with its own labels", async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("Still to save");
    expect(screen.queryByText("Months covered")).not.toBeInTheDocument();
    expect(screen.getByText("Saved so far")).toBeInTheDocument();
    expect(screen.getByText("₹18,95,000", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("a fixed amount")).toBeInTheDocument();
  });

  it("a fully funded goal shows zero shortfall and says so", async () => {
    gf.overview.mockResolvedValue(houseOverview({ balance: "2100000.00", progress: { percent: 105, remaining: "0.00", reached: true }, plan: { ...overview().plan, requiredMonthly: "0.00", monthsToTargetAtPlan: 0, estimatedFinishDate: null } }));
    render(<MoneyGoalsPage />);
    expect(await screen.findByText("fully funded — nothing left to save")).toBeInTheDocument();
    expect(screen.getByText("Target reached")).toBeInTheDocument();
  });

  it("add money goes to THIS goal and refreshes Home without touching the emergency reserve", async () => {
    gf.add.mockResolvedValue({});
    const seen: string[] = [];
    const off = onFinancialChange((k) => seen.push(k));
    render(<MoneyGoalsPage />);
    await screen.findByText("Still to save");
    fireEvent.click(screen.getByRole("button", { name: "+ Add money" }));
    const dialog = await screen.findByRole("dialog", { name: "Add money to House" });
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "5000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add money" }));
    await waitFor(() => expect(gf.add).toHaveBeenCalledWith("g-house", expect.objectContaining({ type: "ALLOCATE", amount: 5000 })));
    expect(await screen.findByRole("status")).toHaveTextContent("set aside for House");
    expect(seen).toContain("goal");
    expect(seen).not.toContain("emergency");
    off();
  });

  it("a house can record a down payment as a non-expense outflow, or as an expense — the user chooses", async () => {
    gf.use.mockResolvedValue({ entry: {} as any, expense: {} as any });
    const seen: string[] = [];
    const off = onFinancialChange((k) => seen.push(k));
    render(<MoneyGoalsPage />);
    await screen.findByText("Still to save");
    fireEvent.click(screen.getByRole("button", { name: "− Use money" }));
    const dialog = await screen.findByRole("dialog", { name: "Use money from House" });
    expect(within(dialog).getByLabelText(/Not an expense/)).toBeChecked();
    expect(within(dialog).getByLabelText(/Counts as an expense/)).not.toBeChecked();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "50000" } });
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), { target: { value: "Down payment" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use money" }));
    await waitFor(() => expect(gf.use).toHaveBeenCalledWith("g-house", expect.objectContaining({ amount: 50000, spend: { mode: "OTHER_OUTFLOW", categoryId: "med", merchant: "Down payment" } })));
    expect(await screen.findByRole("status")).toHaveTextContent("not an expense");
    expect(seen).not.toContain("expense");
    off();
  });

  it("the target dialog offers only a fixed amount (months of expenses is an emergency-fund idea)", async () => {
    gf.setPlan.mockResolvedValue({});
    render(<MoneyGoalsPage />);
    await screen.findByText("Still to save");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Target and plan" });
    expect(within(dialog).queryByLabelText("Months of expenses")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Target amount (₹)")).toHaveValue(2000000);
    fireEvent.change(within(dialog).getByLabelText("Target amount (₹)"), { target: { value: "2500000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gf.setPlan).toHaveBeenCalledWith("g-house", { targetAmount: 2500000, monthlyContribution: 30000, targetDate: "2031-01-01" }));
  });

  it("a goal with no target date says so instead of inventing one", async () => {
    gf.overview.mockResolvedValue(houseOverview({ goal: { ...houseOverview().goal, hasTargetDate: false }, plan: { ...overview().plan, targetDate: null, requiredMonthly: null, requiredWeekly: null } }));
    render(<MoneyGoalsPage />);
    expect(await screen.findByText("Set a date to see what it would take each month.")).toBeInTheDocument();
  });

  it("shows linked investments counted towards the goal without adding them to cash", async () => {
    gf.overview.mockResolvedValue(
      houseOverview({ funding: { cashBalance: "105000.00", linkedInvestmentValue: "40000.00", totalFunded: "145000.00", linkedInvestments: [{ id: "i1", name: "Nifty 50 fund", currentValue: "40000.00" }] } }),
    );
    render(<MoneyGoalsPage />);
    expect(await screen.findByText("Where the money is")).toBeInTheDocument();
    expect(screen.getByText("Nifty 50 fund")).toBeInTheDocument();
    expect(screen.getByText("₹1,45,000")).toBeInTheDocument();
    expect(screen.getByText(/An investment can back only one goal/)).toBeInTheDocument();
  });

  it("a goal whose type cannot be 'spent' (retirement) only offers returning the money to cash", async () => {
    gf.use.mockResolvedValue({ entry: {} as any, expense: null });
    gf.overview.mockResolvedValue(houseOverview({ goal: { ...houseOverview().goal, name: "Retire", type: "RETIREMENT" }, rules: RETIREMENT_RULES }));
    render(<MoneyGoalsPage />);
    await screen.findByText("Still to save");
    fireEvent.click(screen.getByRole("button", { name: "− Use money" }));
    const dialog = await screen.findByRole("dialog", { name: "Use money from Retire" });
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/can only be returned to your cash/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "1000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use money" }));
    await waitFor(() => expect(gf.use).toHaveBeenCalled());
    expect(gf.use.mock.calls[0][1]).not.toHaveProperty("spend");
  });
});

describe("Money → Goals — move money between goals", () => {
  const openMove = async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "⇄ Move money" }));
    return screen.findByRole("dialog", { name: "Move money from Emergency fund" });
  };

  it("moves money to another goal in one request, and says nothing but the two goals changed", async () => {
    gf.reallocate.mockResolvedValue({ groupId: "grp", from: { goalId: "g-ef", entryId: "a" }, to: { goalId: "g-house", entryId: "b" } });
    const seen: string[] = [];
    const off = onFinancialChange((k) => seen.push(k));
    const dialog = await openMove();
    expect(within(dialog).getByLabelText("Move to")).toHaveValue("g-house");
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "4000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move money" }));
    await waitFor(() => expect(gf.reallocate).toHaveBeenCalledWith("g-ef", { toGoalId: "g-house", amount: 4000, occurredAt: localDateString(), notes: undefined, requestId: expect.any(String) }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your cash, income and expenses did not change.");
    expect(seen).toEqual(expect.arrayContaining(["goal", "emergency"]));
    off();
  });

  it("cannot move more than is set aside, and never to itself", async () => {
    const dialog = await openMove();
    const options = within(within(dialog).getByLabelText("Move to")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["House"]);
    fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "90000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move money" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("at most ₹82,000");
    expect(gf.reallocate).not.toHaveBeenCalled();
  });

  it("with no other goal there is nothing to move to", async () => {
    gf.list.mockResolvedValue([fund()]);
    const dialog = await openMove();
    expect(within(dialog).getByText(/You need another active goal/)).toBeInTheDocument();
  });
});

describe("Money → Goals — creating, closing and restoring goals", () => {
  it("creates a goal from here (one record, shared with the Goals overview) and opens it", async () => {
    goals.create.mockResolvedValue({ id: "g-new", name: "Trip", type: "VACATION" } as any);
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "+ New goal" }));
    const dialog = await screen.findByRole("dialog", { name: "New goal" });
    // One emergency fund only: the type is not offered again.
    expect(within(dialog).queryByRole("option", { name: "Emergency fund" })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "VACATION" } });
    fireEvent.change(within(dialog).getByLabelText("Goal name"), { target: { value: "Trip" } });
    fireEvent.change(within(dialog).getByLabelText("Target amount (₹)"), { target: { value: "80000" } });
    fireEvent.change(within(dialog).getByLabelText("Target date"), { target: { value: "2099-01-01" } });
    fireEvent.change(within(dialog).getByLabelText("Already saved (₹, optional)"), { target: { value: "5000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create goal" }));
    await waitFor(() => expect(goals.create).toHaveBeenCalledWith({ type: "VACATION", name: "Trip", targetAmount: 80000, targetDate: new Date("2099-01-01").toISOString(), currentAmount: 5000 }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/money/goals?goal=g-new", { scroll: false }));
  });

  it("validates a new goal before calling the API", async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "+ New goal" }));
    const dialog = await screen.findByRole("dialog", { name: "New goal" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create goal" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Give the goal a name.");
    expect(goals.create).not.toHaveBeenCalled();
  });

  it("closing a goal with history archives it and tells the user what happened to the money", async () => {
    goals.remove.mockResolvedValue({ id: "g-ef", archived: true, releasedAmount: "82000.00" } as any);
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "Close this goal" }));
    expect(screen.getByText(/has history, so it will be closed/)).toBeInTheDocument();
    expect(goals.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close goal" }));
    await waitFor(() => expect(goals.remove).toHaveBeenCalledWith("g-ef"));
    expect(await screen.findByRole("status")).toHaveTextContent("₹82,000 returned to your cash");
  });

  it("shows the server's reason when a goal cannot be closed", async () => {
    const { ApiError } = jest.requireMock("@/lib/api-client");
    goals.remove.mockRejectedValue(new ApiError("Your emergency fund has history and cannot be removed."));
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByRole("button", { name: "Close this goal" }));
    fireEvent.click(screen.getByRole("button", { name: "Close goal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot be removed");
  });

  it("a closed goal is read-only with a restore button", async () => {
    search = "goal=g-house";
    gf.list.mockResolvedValue([fund(), houseFund({ archived: true })]);
    gf.overview.mockResolvedValue(houseOverview({ goal: { ...houseOverview().goal, archived: true } }));
    goals.restore.mockResolvedValue({} as any);
    render(<MoneyGoalsPage />);
    expect(await screen.findByText(/This goal is closed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Add money" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore goal" }));
    await waitFor(() => expect(goals.restore).toHaveBeenCalledWith("g-house"));
  });

  it("'Show closed goals' asks the API for closed goals too", async () => {
    render(<MoneyGoalsPage />);
    await screen.findByText("3.28 months");
    fireEvent.click(screen.getByLabelText("Show closed goals"));
    await waitFor(() => expect(gf.list).toHaveBeenLastCalledWith({ archived: true }));
  });
});
