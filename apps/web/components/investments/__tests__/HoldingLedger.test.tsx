import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HoldingLedger } from "../HoldingLedger";
import { api } from "@/lib/api-client";
import { onFinancialChange } from "@/lib/financial-events";
import { localDateString } from "@/lib/dates";
import { cashflow, holding, metrics, schedule } from "@/__fixtures__/investments";

jest.mock("@/lib/api-client", () => ({
  api: {
    investments: {
      metrics: jest.fn(),
      cashflows: jest.fn(),
      valuations: jest.fn(),
      sipSchedule: jest.fn(),
      addCashflow: jest.fn(),
      removeCashflow: jest.fn(),
      addValuation: jest.fn(),
      setSipSchedule: jest.fn(),
      generateSip: jest.fn(),
      recordSale: jest.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));

const mocked = api as jest.Mocked<typeof api>;
const inv = api.investments as jest.Mocked<typeof api.investments>;

const setup = (item = holding(), onChanged = jest.fn()) => {
  render(<HoldingLedger investment={item} onChanged={onChanged} />);
  return { onChanged };
};
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

beforeEach(() => {
  jest.clearAllMocks();
  inv.metrics.mockResolvedValue(metrics());
  inv.cashflows.mockResolvedValue([cashflow()]);
  inv.valuations.mockResolvedValue([{ id: "v1", userId: "u1", investmentId: "h1", value: "10500.00", valuedAt: "2026-09-30T00:00:00Z", origin: "MANUAL" }] as any);
  inv.sipSchedule.mockResolvedValue(schedule());
});

describe("HoldingLedger — summary", () => {
  it("loads the whole ledger for just this holding and shows the server's figures", async () => {
    setup();
    expect(await screen.findByText("You put in")).toBeInTheDocument();
    for (const fn of [inv.metrics, inv.cashflows, inv.valuations, inv.sipSchedule]) expect(fn).toHaveBeenCalledWith("h1");
    expect(screen.getAllByText("₹10,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+₹500").length).toBe(2); // unrealised gain and total return
    expect(screen.getByText("5.0%")).toBeInTheDocument(); // return ratio 0.05
    expect(screen.getByText("Using your latest recorded value.")).toBeInTheDocument();
  });

  it("Part 58: ₹10,000 put in and valued at ₹10,500 → ₹500 is a gain; contributions stay ₹10,000", async () => {
    setup();
    await screen.findByText("You put in");
    const kpi = (label: string) => screen.getByText(label).closest("div") as HTMLElement;
    expect(kpi("You put in")).toHaveTextContent("₹10,000");
    expect(kpi("Unrealised gain")).toHaveTextContent("+₹500");
    expect(kpi("Net put in")).toHaveTextContent("₹10,000");
  });

  it("is honest when no contributions are recorded (the return is not meaningful)", async () => {
    inv.metrics.mockResolvedValue(metrics({ grossContributions: "0.00", returnRatio: null, totalReturn: "0.00" }));
    setup();
    expect(await screen.findByText(/No contributions are recorded for this holding yet/)).toBeInTheDocument();
  });

  it("says when the value is the legacy saved one rather than a dated valuation", async () => {
    inv.metrics.mockResolvedValue(metrics({ valuationSource: "LEGACY_CURRENT_VALUE" }));
    setup();
    expect(await screen.findByText(/No dated value recorded yet/)).toBeInTheDocument();
  });

  it("shows a loss with a minus sign, not colour alone", async () => {
    inv.metrics.mockResolvedValue(metrics({ unrealizedGain: "-300.00", totalReturn: "-300.00", returnRatio: "-0.03" }));
    setup();
    expect(await screen.findAllByText("−₹300")).not.toHaveLength(0);
    expect(screen.getByText("-3.0%")).toBeInTheDocument();
  });

  it("reports a load failure", async () => {
    inv.metrics.mockRejectedValue(new Error("down"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this holding's history.");
  });
});

describe("HoldingLedger — transactions", () => {
  const openLedger = async () => {
    setup();
    await screen.findByText("You put in");
    tab("Transactions");
  };

  it("lists each entry with what it means for YOUR cash", async () => {
    inv.cashflows.mockResolvedValue([
      cashflow({ id: "a", type: "CONTRIBUTION", amount: "10000.00" }),
      cashflow({ id: "b", type: "SALE", amount: "6000.00" }),
      cashflow({ id: "c", type: "INTEREST", amount: "250.00" }),
    ]);
    await openLedger();
    expect(screen.getByText("Contribution")).toBeInTheDocument();
    expect(screen.getByText("Sale proceeds")).toBeInTheDocument();
    expect(screen.getByText("from your cash")).toBeInTheDocument();
    expect(screen.getByText("to your cash")).toBeInTheDocument();
    expect(screen.getByText("inside the investment")).toBeInTheDocument();
  });

  it("marks schedule-generated entries", async () => {
    inv.cashflows.mockResolvedValue([cashflow({ origin: "RECURRING" })]);
    await openLedger();
    expect(screen.getByText("from schedule")).toBeInTheDocument();
  });

  it("an empty ledger explains how to start", async () => {
    inv.cashflows.mockResolvedValue([]);
    await openLedger();
    expect(screen.getByText(/No transactions yet/)).toBeInTheDocument();
  });

  it("asks before deleting an entry, then deletes it and refreshes the page", async () => {
    inv.removeCashflow.mockResolvedValue({ deleted: true });
    const { onChanged } = setup();
    await screen.findByText("You put in");
    tab("Transactions");
    fireEvent.click(await screen.findByRole("button", { name: /Delete Contribution of ₹10,000/ }));
    expect(screen.getByText("Delete this entry?")).toBeInTheDocument();
    expect(inv.removeCashflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(inv.removeCashflow).toHaveBeenCalledWith("h1", "cf1"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("warns that a schedule-created entry would be created again", async () => {
    inv.cashflows.mockResolvedValue([cashflow({ origin: "RECURRING" })]);
    await openLedger();
    fireEvent.click(screen.getByRole("button", { name: /Delete Contribution/ }));
    expect(screen.getByText(/would be created again/)).toBeInTheDocument();
  });

  describe("adding a transaction", () => {
    const openDialog = async (item = holding()) => {
      setup(item);
      await screen.findByText("You put in");
      fireEvent.click(screen.getByRole("button", { name: "+ Transaction" }));
      return screen.findByRole("dialog", { name: /Add a transaction/ });
    };

    it("Part 58: a ₹10,000 contribution goes to the ledger and is described as NOT an expense", async () => {
      inv.addCashflow.mockResolvedValue(cashflow());
      const seen: string[] = [];
      const off = onFinancialChange((k) => seen.push(k));
      const dialog = await openDialog();
      expect(within(dialog).getByText(/not an expense/i)).toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "10000" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record" }));

      await waitFor(() => expect(inv.addCashflow).toHaveBeenCalledWith("h1", { type: "CONTRIBUTION", amount: 10000, occurredAt: localDateString(), notes: undefined }));
      expect(await screen.findByRole("status")).toHaveTextContent("It is not counted as an expense");
      expect(seen).toContain("investment"); // dashboard / reports / net worth refresh
      off();
    });

    it("explains each entry type as it is chosen", async () => {
      const dialog = await openDialog();
      fireEvent.change(within(dialog).getByLabelText("What happened"), { target: { value: "FEE" } });
      expect(within(dialog).getByText(/A genuine cost/)).toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText("What happened"), { target: { value: "INTEREST" } });
      expect(within(dialog).getByText(/not new money from you/)).toBeInTheDocument();
    });

    it("offers an employer contribution only for EPF / NPS", async () => {
      const dialog = await openDialog(holding({ type: "MUTUAL_FUND" }));
      expect(within(dialog).queryByRole("option", { name: "Employer contribution" })).not.toBeInTheDocument();
    });

    it("EPF can record an employer contribution", async () => {
      const dialog = await openDialog(holding({ id: "h1", type: "EPF" }));
      expect(within(dialog).getByRole("option", { name: "Employer contribution" })).toBeInTheDocument();
    });

    it("rejects a zero amount without calling the API", async () => {
      const dialog = await openDialog();
      fireEvent.click(within(dialog).getByRole("button", { name: "Record" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter an amount greater than zero.");
      expect(inv.addCashflow).not.toHaveBeenCalled();
    });

    it("shows the server's message when it is refused (e.g. an invalid type for this holding)", async () => {
      const { ApiError } = jest.requireMock("@/lib/api-client");
      inv.addCashflow.mockRejectedValue(new ApiError("Employer contributions only apply to EPF and NPS"));
      const dialog = await openDialog();
      fireEvent.change(within(dialog).getByLabelText("Amount (₹)"), { target: { value: "5" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Record" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("only apply to EPF and NPS");
    });
  });
});

describe("HoldingLedger — value history and valuations", () => {
  it("lists dated values", async () => {
    setup();
    await screen.findByText("You put in");
    tab("Value history");
    expect(await screen.findByText("₹10,500")).toBeInTheDocument();
  });

  it("Part 58: updating the value to ₹10,500 records a VALUATION and says it is a gain, not a contribution", async () => {
    inv.addValuation.mockResolvedValue({} as any);
    setup();
    await screen.findByText("You put in");
    fireEvent.click(screen.getByRole("button", { name: "Update value" }));
    const dialog = await screen.findByRole("dialog", { name: /Update value/ });
    expect(within(dialog).getByText(/does not add any money you put in/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Value (₹)"), { target: { value: "10500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Update value" }));
    await waitFor(() => expect(inv.addValuation).toHaveBeenCalledWith("h1", { value: 10500, valuedAt: localDateString() }));
    expect(inv.addCashflow).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("not a contribution");
  });

  it("an empty history explains how to build one", async () => {
    inv.valuations.mockResolvedValue([]);
    setup();
    await screen.findByText("You put in");
    tab("Value history");
    expect(screen.getByText(/No dated values yet/)).toBeInTheDocument();
  });
});

describe("HoldingLedger — recording a sale", () => {
  const openSale = async () => {
    setup();
    await screen.findByText("You put in");
    fireEvent.click(screen.getByRole("button", { name: "Record sale" }));
    return screen.findByRole("dialog", { name: /Record a sale/ });
  };
  const fill = (dialog: HTMLElement) => {
    fireEvent.change(within(dialog).getByLabelText("Amount received (₹)"), { target: { value: "60000" } });
    fireEvent.change(within(dialog).getByLabelText("Original cost of what you sold (₹)"), { target: { value: "40000" } });
  };

  it("by default records the tax record AND the proceeds reaching cash, atomically (one request)", async () => {
    inv.recordSale.mockResolvedValue({});
    const dialog = await openSale();
    expect(within(dialog).getByRole("checkbox")).toBeChecked();
    fill(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Record sale" }));
    await waitFor(() =>
      expect(inv.recordSale).toHaveBeenCalledWith("h1", { saleDate: localDateString(), proceeds: 60000, costBasisPortion: 40000, notes: undefined, alsoRecordCashflow: true }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("₹60,000 added to your cash");
  });

  it("unchecked: tax record only, cash untouched, and it says so", async () => {
    inv.recordSale.mockResolvedValue({});
    const dialog = await openSale();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fill(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Record sale" }));
    await waitFor(() => expect(inv.recordSale).toHaveBeenCalled());
    expect(inv.recordSale.mock.calls[0][1]).not.toHaveProperty("alsoRecordCashflow");
    expect(await screen.findByRole("status")).toHaveTextContent("Your cash was not changed");
  });

  it("requires the amount received", async () => {
    const dialog = await openSale();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record sale" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter the amount you received.");
    expect(inv.recordSale).not.toHaveBeenCalled();
  });
});

describe("HoldingLedger — recurring contribution", () => {
  const openSchedule = async () => {
    setup();
    await screen.findByText("You put in");
    tab("Recurring");
  };

  it("shows the schedule with its derived figures straight from the server", async () => {
    await openSchedule();
    expect(await screen.findByText(/₹1,000 · weekly/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("₹4,333")).toBeInTheDocument(); // monthly equivalent
    expect(screen.getByText("₹52,000")).toBeInTheDocument(); // per year
    expect(screen.getByText("12% a year")).toBeInTheDocument(); // expected return, labelled an assumption
    expect(screen.getByText("open-ended")).toBeInTheDocument();
  });

  it("names a biweekly schedule plainly", async () => {
    inv.sipSchedule.mockResolvedValue(schedule({ frequency: "BIWEEKLY" }));
    await openSchedule();
    expect(await screen.findByText(/every 2 weeks/)).toBeInTheDocument();
  });

  it("shows planned / remaining counts for a schedule with an end date", async () => {
    inv.sipSchedule.mockResolvedValue(schedule({ plannedCount: 17, remainingCount: 12, plannedTotal: "17000.00" }));
    await openSchedule();
    expect(await screen.findByText("17 · ₹17,000")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("with no schedule it invites setting one up", async () => {
    inv.sipSchedule.mockResolvedValue(schedule({ amountPerPeriod: null, active: false, frequency: "MONTHLY", startDate: null }));
    await openSchedule();
    expect(await screen.findByRole("button", { name: "Set up a schedule" })).toBeInTheDocument();
  });

  it("'Create due contributions now' reports what it created", async () => {
    inv.generateSip.mockResolvedValue({ created: ["2026-10-05", "2026-10-12"], alreadyExisted: [] });
    await openSchedule();
    fireEvent.click(await screen.findByRole("button", { name: "Create due contributions now" }));
    await waitFor(() => expect(inv.generateSip).toHaveBeenCalledWith("h1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Created 2 due contributions.");
  });

  it("tells you when nothing is due", async () => {
    inv.generateSip.mockResolvedValue({ created: [], alreadyExisted: ["2026-10-05"] });
    await openSchedule();
    fireEvent.click(await screen.findByRole("button", { name: "Create due contributions now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing is due right now");
  });

  it("a paused schedule offers no 'create now'", async () => {
    inv.sipSchedule.mockResolvedValue(schedule({ active: false }));
    await openSchedule();
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create due contributions now" })).not.toBeInTheDocument();
  });

  describe("schedule dialog", () => {
    // What the API really returns for a holding with no schedule: inactive, monthly, nothing set.
    const noSchedule = () => schedule({ amountPerPeriod: null, active: false, frequency: "MONTHLY", startDate: null, expectedAnnualReturn: null, monthlyEquivalent: null, annualContribution: null, nextContributionDate: null, actualCount: 0, actualAmount: "0.00" });
    const openDialog = async (s = noSchedule()) => {
      inv.sipSchedule.mockResolvedValue(s);
      await openSchedule();
      fireEvent.click(await screen.findByRole("button", { name: /Set up a schedule|Edit schedule/ }));
      return screen.findByRole("dialog", { name: /Recurring contribution/ });
    };
    const monthStart = () => `${localDateString().slice(0, 7)}-01`;

    it("a NEW schedule starts out active, monthly and beginning today (not copied from the empty 'off' state)", async () => {
      const dialog = await openDialog();
      expect(within(dialog).getByLabelText(/Active — create each contribution/)).toBeChecked();
      expect(within(dialog).getByLabelText("How often")).toHaveValue("MONTHLY");
      expect(within(dialog).getByLabelText("Start date")).toHaveValue(localDateString());
    });

    it("saves a weekly schedule with an expected return (no day of month for weekly)", async () => {
      inv.setSipSchedule.mockResolvedValue({} as any);
      const dialog = await openDialog();
      fireEvent.change(within(dialog).getByLabelText("How often"), { target: { value: "WEEKLY" } });
      expect(within(dialog).queryByLabelText("Day of the month")).not.toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText("Amount each time (₹)"), { target: { value: "1000" } });
      fireEvent.change(within(dialog).getByLabelText("Start date"), { target: { value: localDateString() } });
      fireEvent.change(within(dialog).getByLabelText("Expected return per year, % (optional)"), { target: { value: "12" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
      await waitFor(() =>
        expect(inv.setSipSchedule).toHaveBeenCalledWith("h1", { monthlyContribution: 1000, frequency: "WEEKLY", startDate: localDateString(), active: true, expectedAnnualReturn: 12 }),
      );
      expect(await screen.findByRole("status")).toHaveTextContent("never in advance");
    });

    it("monthly shows the day of the month and sends it", async () => {
      inv.setSipSchedule.mockResolvedValue({} as any);
      const dialog = await openDialog();
      fireEvent.change(within(dialog).getByLabelText("Amount each time (₹)"), { target: { value: "10000" } });
      fireEvent.change(within(dialog).getByLabelText("Start date"), { target: { value: monthStart() } });
      fireEvent.change(within(dialog).getByLabelText("Day of the month"), { target: { value: "5" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
      await waitFor(() => expect(inv.setSipSchedule).toHaveBeenCalledWith("h1", expect.objectContaining({ frequency: "MONTHLY", contributionDay: 5, monthlyContribution: 10000 })));
    });

    it("a start date before this month requires confirming the past contributions really happened", async () => {
      inv.setSipSchedule.mockResolvedValue({} as any);
      const dialog = await openDialog();
      fireEvent.change(within(dialog).getByLabelText("Amount each time (₹)"), { target: { value: "1000" } });
      fireEvent.change(within(dialog).getByLabelText("Start date"), { target: { value: "2020-01-06" } });
      expect(within(dialog).getByText(/will be recorded as real contributions/)).toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("confirm the past contributions really happened");
      expect(inv.setSipSchedule).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByLabelText(/The start date is in the past/));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
      await waitFor(() => expect(inv.setSipSchedule).toHaveBeenCalledWith("h1", expect.objectContaining({ startDate: "2020-01-06", confirmBackfill: true })));
    });

    it("pausing a schedule needs no backfill confirmation (nothing is created)", async () => {
      inv.setSipSchedule.mockResolvedValue({} as any);
      const dialog = await openDialog(schedule({ startDate: "2020-01-06T00:00:00Z" }));
      fireEvent.click(within(dialog).getByLabelText(/Active — create each contribution/));
      expect(within(dialog).queryByText(/will be recorded as real contributions/)).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
      await waitFor(() => expect(inv.setSipSchedule).toHaveBeenCalledWith("h1", expect.objectContaining({ active: false })));
      expect(inv.setSipSchedule.mock.calls[0][1]).not.toHaveProperty("confirmBackfill");
      expect(await screen.findByRole("status")).toHaveTextContent("saved and paused");
    });

    it("rejects an end date before the start date, and a missing amount", async () => {
      const dialog = await openDialog();
      fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter the amount for each contribution.");
      fireEvent.change(within(dialog).getByLabelText("Amount each time (₹)"), { target: { value: "500" } });
      fireEvent.change(within(dialog).getByLabelText("Start date"), { target: { value: monthStart() } });
      fireEvent.change(within(dialog).getByLabelText("End date (optional)"), { target: { value: "2000-01-01" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("end date cannot be before the start date");
      expect(inv.setSipSchedule).not.toHaveBeenCalled();
    });

    it("offers every frequency, including every 2 weeks", async () => {
      const dialog = await openDialog();
      const options = within(within(dialog).getByLabelText("How often")).getAllByRole("option").map((o) => o.textContent);
      expect(options).toEqual(["Weekly", "Every 2 weeks", "Monthly", "Quarterly", "Yearly"]);
    });
  });
});
