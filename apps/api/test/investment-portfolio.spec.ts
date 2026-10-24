import { buildPortfolio, PortfolioCashflowInput, PortfolioHoldingInput } from "../src/investments/investment-portfolio.util";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = d("2026-10-23");

const holding = (over: Partial<PortfolioHoldingInput> & { id: string }): PortfolioHoldingInput => ({
  name: over.id,
  type: "MUTUAL_FUND",
  currentValue: 0,
  costBasis: 0,
  purchaseDate: d("2025-01-01"),
  sipActive: false,
  monthlyContribution: null,
  contributionFrequency: null,
  contributionStartDate: null,
  contributionEndDate: null,
  sipCancelledAt: null,
  latestValuation: null,
  ...over,
});
const cf = (investmentId: string, type: PortfolioCashflowInput["type"], amount: number, date: string): PortfolioCashflowInput => ({ investmentId, type, amount, occurredAt: d(date) });

describe("buildPortfolio", () => {
  it("empty portfolio: zeros, no NaN, no XIRR", () => {
    const p = buildPortfolio([], [], [], NOW);
    expect(p.totals.totalInvested).toBe("0.00");
    expect(p.totals.currentValue).toBe("0.00");
    expect(p.totals.returnRatio).toBeNull();
    expect(p.totals.xirr).toBeNull();
    expect(p.counts.holdings).toBe(0);
    expect(p.allocation).toEqual([]);
  });

  it("lump sum + extra purchase: invested is the sum, gain is value - invested", () => {
    const p = buildPortfolio(
      [holding({ id: "a", latestValuation: { value: 130_000, valuedAt: d("2026-10-20") } })],
      [cf("a", "CONTRIBUTION", 100_000, "2025-10-01"), cf("a", "CONTRIBUTION", 20_000, "2026-04-01")],
      [],
      NOW,
    );
    expect(p.totals.totalInvested).toBe("120000.00");
    expect(p.totals.unrealizedGain).toBe("10000.00");
    expect(p.totals.returnRatio).toBe("0.083333");
    expect(p.totals.xirr).not.toBeNull();
    expect(Number(p.totals.xirr)).toBeGreaterThan(0.05);
    expect(p.holdings[0].freshness).toBe("FRESH");
    expect(p.holdings[0].costBasisSource).toBe("LEDGER");
  });

  it("partial sale: remaining basis excludes the realised portion; realised and unrealised stay separate", () => {
    const p = buildPortfolio(
      [holding({ id: "a", latestValuation: { value: 70_000, valuedAt: d("2026-10-20") } })],
      [cf("a", "CONTRIBUTION", 100_000, "2025-10-01"), cf("a", "SALE", 45_000, "2026-06-01")],
      [{ investmentId: "a", costBasisPortion: 40_000, gainAmount: 5_000 }],
      NOW,
    );
    expect(p.totals.totalInvested).toBe("60000.00"); // 100k - 40k basis sold
    expect(p.totals.unrealizedGain).toBe("10000.00"); // 70k - 60k
    expect(p.totals.realizedGain).toBe("5000.00");
    expect(p.totals.withdrawn).toBe("45000.00");
    expect(p.totals.totalReturn).toBe("15000.00"); // 70k + 45k - 100k
  });

  it("SIP: planned monthly is separate from what was actually contributed; paused/cancelled plan nothing", () => {
    const sip = { monthlyContribution: 5000, contributionFrequency: "MONTHLY", contributionStartDate: d("2026-01-05") };
    const p = buildPortfolio(
      [
        holding({ id: "active", sipActive: true, ...sip, latestValuation: { value: 25_000, valuedAt: d("2026-10-20") } }),
        holding({ id: "paused", sipActive: false, ...sip }),
        holding({ id: "cancelled", sipActive: false, sipCancelledAt: d("2026-05-01"), contributionEndDate: d("2026-05-01"), ...sip }),
        holding({ id: "weekly", sipActive: true, monthlyContribution: 1000, contributionFrequency: "WEEKLY", contributionStartDate: d("2026-01-05") }),
      ],
      [cf("active", "CONTRIBUTION", 5000, "2026-09-05"), cf("active", "CONTRIBUTION", 5000, "2026-10-05")],
      [],
      NOW,
    );
    expect(p.contributions.plannedMonthly).toBe((5000 + (1000 * 52) / 12).toFixed(2));
    expect(p.contributions.plannedAnnual).toBe((60_000 + 52_000).toFixed(2));
    expect(p.contributions.actualThisMonth).toBe("5000.00");
    expect(p.counts).toMatchObject({ activeSips: 2, pausedSips: 1, endedSips: 1, oneTime: 0 });
    expect(p.holdings.find((h) => h.id === "paused")!.plannedMonthly).toBeNull();
  });

  it("a scheduled-but-unrecorded SIP is NOT invested (only ledger rows are)", () => {
    const p = buildPortfolio(
      [holding({ id: "s", sipActive: true, monthlyContribution: 5000, contributionFrequency: "MONTHLY", contributionStartDate: d("2025-01-05") })],
      [],
      [],
      NOW,
    );
    expect(p.totals.totalInvested).toBe("0.00");
    expect(p.contributions.plannedMonthly).toBe("5000.00");
  });

  it("financial-year boundary: 31 March belongs to the old year, 1 April to the new", () => {
    const p = buildPortfolio(
      [holding({ id: "a" })],
      [cf("a", "CONTRIBUTION", 1000, "2026-03-31"), cf("a", "CONTRIBUTION", 2000, "2026-04-01"), cf("a", "CONTRIBUTION", 4000, "2025-12-01")],
      [],
      NOW,
    );
    expect(p.contributions.financialYear).toBe("2026-27");
    expect(p.contributions.actualThisFinancialYear).toBe("2000.00");
    expect(p.contributions.actualThisCalendarYear).toBe("3000.00");
  });

  it("transfers move capital between holdings: neither a new contribution nor new wealth", () => {
    const p = buildPortfolio(
      [holding({ id: "a", latestValuation: { value: 60_000, valuedAt: d("2026-10-01") } }), holding({ id: "b", latestValuation: { value: 40_000, valuedAt: d("2026-10-01") } })],
      [cf("a", "CONTRIBUTION", 100_000, "2025-10-01"), cf("a", "TRANSFER_OUT", 40_000, "2026-01-01"), cf("b", "TRANSFER_IN", 40_000, "2026-01-01")],
      [],
      NOW,
    );
    expect(p.contributions.actualThisCalendarYear).toBe("0.00");
    // Whole portfolio: 100k in, 100k worth, so the transfer nets out to a zero gain.
    expect(p.totals.totalReturn).toBe("0.00");
  });

  it("a holding with no ledger uses its legacy cost basis and is flagged; legacy value is UNDATED", () => {
    const p = buildPortfolio([holding({ id: "old", currentValue: 150_000, costBasis: 100_000 })], [], [], NOW);
    const h = p.holdings[0];
    expect(h.costBasisSource).toBe("LEGACY");
    expect(h.freshness).toBe("UNDATED");
    expect(h.unrealizedGain).toBe("50000.00");
    expect(h.xirr).toBeNull();
    expect(p.counts.legacyCostBasis).toBe(1);
    expect(p.counts.staleValuations).toBe(1);
    expect(p.totals.xirrCoveredHoldings).toBe(0);
  });

  it("stale valuations (older than 120 days) are flagged", () => {
    const p = buildPortfolio([holding({ id: "a", latestValuation: { value: 1000, valuedAt: d("2026-04-01") } })], [cf("a", "CONTRIBUTION", 900, "2026-01-01")], [], NOW);
    expect(p.holdings[0].freshness).toBe("STALE");
    expect(p.counts.staleValuations).toBe(1);
  });

  it("a valuation dated in the future is ignored", () => {
    const p = buildPortfolio([holding({ id: "a", currentValue: 500, latestValuation: { value: 9999, valuedAt: d("2027-01-01") } })], [], [], NOW);
    expect(p.holdings[0].currentValue).toBe("500.00");
  });

  it("dividends and fees are reported, not folded into value; zero invested gives no percentage", () => {
    const p = buildPortfolio(
      [holding({ id: "a", latestValuation: { value: 11_000, valuedAt: d("2026-10-01") } }), holding({ id: "z" })],
      [cf("a", "CONTRIBUTION", 10_000, "2025-10-01"), cf("a", "DIVIDEND", 300, "2026-03-01"), cf("a", "FEE", 100, "2026-04-01")],
      [],
      NOW,
    );
    expect(p.totals.dividends).toBe("300.00");
    expect(p.totals.fees).toBe("100.00");
    expect(p.totals.totalReturn).toBe("1200.00"); // 11,000 + 300 - 100 - 10,000
    expect(p.holdings.find((h) => h.id === "z")!.returnRatio).toBeNull();
  });

  it("allocation percentages cover the current value", () => {
    const p = buildPortfolio(
      [holding({ id: "a", type: "STOCK", latestValuation: { value: 75, valuedAt: d("2026-10-01") } }), holding({ id: "b", type: "GOLD", latestValuation: { value: 25, valuedAt: d("2026-10-01") } })],
      [cf("a", "CONTRIBUTION", 50, "2026-01-01"), cf("b", "CONTRIBUTION", 20, "2026-01-01")],
      [],
      NOW,
    );
    expect(p.allocation.map((a) => [a.type, a.percent])).toEqual([["STOCK", 75], ["GOLD", 25]]);
  });
});
