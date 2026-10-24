import { DatedFlow, financialYearLabel, financialYearStart, ledgerToFlows, sipStatusOf, xirr } from "../src/investments/investment-returns.util";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const npvAt = (flows: DatedFlow[], rate: number) => {
  const t0 = Math.min(...flows.map((f) => f.date.getTime()));
  return flows.reduce((s, f) => s + f.amount / Math.pow(1 + rate, (f.date.getTime() - t0) / 86_400_000 / 365), 0);
};

describe("xirr", () => {
  it("one investment held a year: ₹1,000 -> ₹1,100 is 10%", () => {
    const r = xirr([{ date: d("2025-10-01"), amount: -1000 }, { date: d("2026-10-01"), amount: 1100 }]);
    expect(r.reason).toBe("OK");
    expect(r.rate!).toBeCloseTo(0.1, 5);
  });

  it("a monthly SIP: the rate solves NPV = 0 over the dated flows", () => {
    const flows: DatedFlow[] = [];
    for (let m = 0; m < 12; m++) flows.push({ date: new Date(Date.UTC(2025, m, 5)), amount: -1000 });
    flows.push({ date: d("2026-01-05"), amount: 12_900 });
    const r = xirr(flows);
    expect(r.reason).toBe("OK");
    expect(Math.abs(npvAt(flows, r.rate!))).toBeLessThan(1e-4);
    expect(r.rate!).toBeGreaterThan(0.12); // 7.5% gain on money held ~half a year on average
    expect(r.rate!).toBeLessThan(0.16);
  });

  it("a loss gives a negative rate", () => {
    const r = xirr([{ date: d("2025-10-01"), amount: -1000 }, { date: d("2026-10-01"), amount: 900 }]);
    expect(r.rate!).toBeCloseTo(-0.1, 5);
  });

  it("partial withdrawals are handled (money back mid-way)", () => {
    const flows: DatedFlow[] = [
      { date: d("2024-10-01"), amount: -10_000 },
      { date: d("2025-10-01"), amount: 3_000 },
      { date: d("2026-10-01"), amount: 9_000 },
    ];
    const r = xirr(flows);
    expect(r.reason).toBe("OK");
    expect(Math.abs(npvAt(flows, r.rate!))).toBeLessThan(1e-4);
  });

  it("refuses rather than invent a number", () => {
    expect(xirr([])).toEqual({ rate: null, reason: "NO_FLOWS" });
    expect(xirr([{ date: d("2025-01-01"), amount: -1000 }]).reason).toBe("NEEDS_BOTH_SIGNS");
    expect(xirr([{ date: d("2025-01-01"), amount: 1000 }]).reason).toBe("NEEDS_BOTH_SIGNS");
    // 10 days is too short to annualise honestly.
    expect(xirr([{ date: d("2026-10-01"), amount: -1000 }, { date: d("2026-10-11"), amount: 1100 }])).toEqual({ rate: null, reason: "SHORT_HISTORY" });
  });

  it("never returns NaN or Infinity, even for a total loss", () => {
    const r = xirr([{ date: d("2025-10-01"), amount: -1000 }, { date: d("2026-10-01"), amount: 0.01 }]);
    if (r.rate !== null) expect(Number.isFinite(r.rate)).toBe(true);
  });
});

describe("ledgerToFlows", () => {
  it("contributions and fees go out; withdrawals, sales, dividends come back; interest is not a flow", () => {
    const flows = ledgerToFlows(
      [
        { type: "CONTRIBUTION", amount: 100, date: d("2026-01-01") },
        { type: "EMPLOYER_CONTRIBUTION", amount: 50, date: d("2026-01-01") },
        { type: "FEE", amount: 2, date: d("2026-02-01") },
        { type: "DIVIDEND", amount: 5, date: d("2026-03-01") },
        { type: "SALE", amount: 40, date: d("2026-04-01") },
        { type: "INTEREST", amount: 9, date: d("2026-05-01") },
      ],
      200,
      d("2026-10-01"),
    );
    expect(flows.map((f) => f.amount)).toEqual([-100, -50, -2, 5, 40, 200]);
  });

  it("omits the closing value when it is zero", () => {
    expect(ledgerToFlows([{ type: "CONTRIBUTION", amount: 1, date: d("2026-01-01") }], 0, d("2026-10-01"))).toHaveLength(1);
  });
});

describe("sipStatusOf", () => {
  const now = d("2026-10-23");
  const base = { hasSchedule: true, active: true, endDate: null, cancelledAt: null };
  it("covers every state", () => {
    expect(sipStatusOf({ ...base, hasSchedule: false }, now)).toBe("NONE");
    expect(sipStatusOf(base, now)).toBe("ACTIVE");
    expect(sipStatusOf({ ...base, active: false }, now)).toBe("PAUSED");
    expect(sipStatusOf({ ...base, endDate: d("2026-01-01") }, now)).toBe("COMPLETED");
    expect(sipStatusOf({ ...base, active: false, cancelledAt: d("2026-06-01") }, now)).toBe("CANCELLED");
  });
  it("cancelled wins over an end date that cancelling itself set", () => {
    expect(sipStatusOf({ ...base, active: false, endDate: d("2026-06-01"), cancelledAt: d("2026-06-01") }, now)).toBe("CANCELLED");
  });
});

describe("Indian financial year", () => {
  it("starts 1 April", () => {
    expect(financialYearStart(d("2026-03-31")).toISOString()).toBe("2025-04-01T00:00:00.000Z");
    expect(financialYearStart(d("2026-04-01")).toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(financialYearLabel(d("2026-10-23"))).toBe("2026-27");
    expect(financialYearLabel(d("2027-02-01"))).toBe("2026-27");
  });
});
