// Shared fixtures for the investments tests. Values are plain API-shaped data — the tests never
// compute money themselves; they check that what the server says is what the page shows.
export const holding = (over: Record<string, unknown> = {}): any => ({
  id: "h1",
  userId: "u1",
  type: "MUTUAL_FUND",
  name: "Nifty 50 Index Fund",
  currentValue: "10500",
  costBasis: "10000",
  purchaseDate: "2024-01-10T00:00:00.000Z",
  riskLevel: "MODERATE",
  liquidity: "LIQUID",
  sipActive: false,
  monthlyContribution: null,
  contributionFrequency: "MONTHLY",
  expectedAnnualReturn: null,
  ...over,
});

export const metrics = (over: Record<string, unknown> = {}): any => ({
  investmentId: "h1",
  name: "Nifty 50 Index Fund",
  type: "MUTUAL_FUND",
  basis: "ACTUAL",
  period: "LIFETIME",
  asOfDate: "2026-10-05T00:00:00Z",
  valuationSource: "VALUATION",
  grossContributions: "10000.00",
  employerContributions: "0.00",
  withdrawals: "0.00",
  netContributions: "10000.00",
  costBasis: "10000.00",
  currentValue: "10500.00",
  unrealizedGain: "500.00",
  realizedGain: "0.00",
  dividends: "0.00",
  fees: "0.00",
  totalReturn: "500.00",
  returnRatio: "0.05",
  ...over,
});

export const cashflow = (over: Record<string, unknown> = {}): any => ({
  id: "cf1",
  userId: "u1",
  investmentId: "h1",
  type: "CONTRIBUTION",
  amount: "10000.00",
  occurredAt: "2026-09-05T00:00:00.000Z",
  notes: null,
  origin: "MANUAL",
  periodKey: null,
  ...over,
});

export const schedule = (over: Record<string, unknown> = {}): any => ({
  investmentId: "h1",
  active: true,
  frequency: "WEEKLY",
  amountPerPeriod: "1000.00",
  contributionDay: null,
  startDate: "2026-09-07T00:00:00.000Z",
  endDate: null,
  expectedAnnualReturn: "12",
  monthlyEquivalent: "4333.33",
  annualContribution: "52000.00",
  nextContributionDate: "2026-10-12T00:00:00.000Z",
  plannedCount: null,
  dueSoFarCount: 5,
  remainingCount: null,
  plannedTotal: null,
  actualCount: 5,
  actualAmount: "5000.00",
  ...over,
});

export const analyticsData = (over: Record<string, unknown> = {}): any => ({
  basis: "ACTUAL",
  months: ["2026-09", "2026-10"],
  contributionTrend: [
    { month: "2026-09", contributions: "10000.00", employer: "0.00", withdrawals: "0.00" },
    { month: "2026-10", contributions: "0.00", employer: "0.00", withdrawals: "0.00" },
  ],
  valueTrend: [
    { month: "2026-09", value: "10500.00", holdingsValued: 1 },
    { month: "2026-10", value: "10500.00", holdingsValued: 1 },
  ],
  gainTrend: [
    { month: "2026-09", gain: "500.00", coveredHoldings: 1 },
    { month: "2026-10", gain: "500.00", coveredHoldings: 1 },
  ],
  allocation: {
    totalValue: "10500.00",
    byType: [{ key: "MUTUAL_FUND", value: "10500.00", percent: 100 }],
    byRisk: [{ key: "MODERATE", value: "10500.00", percent: 100 }],
    byLiquidity: [{ key: "LIQUID", value: "10500.00", percent: 100 }],
  },
  overview: {
    holdings: 1,
    holdingsWithLedger: 1,
    activeSchedules: 2,
    plannedMonthlyContribution: "14333.33",
    plannedAnnualContribution: "172000.00",
    actualContributionsThisMonth: "3000.00",
    actualContributionsThisYear: "42000.00",
  },
  ...over,
});

export const scenario = (years: number, over: Record<string, unknown> = {}): any => ({
  years,
  totalContributions: "1200000.00",
  principal: "1200000.00",
  projectedValue: "2323390.76",
  projectedGain: "1123390.76",
  ...over,
});

export const portfolioProjection = (over: Record<string, unknown> = {}): any => ({
  basis: "PROJECTED",
  disclaimer: "A projection, not a promise: it assumes the same return every year and is built only from the numbers shown. Real returns vary and can be negative.",
  actual: { basis: "ACTUAL", currentValue: "10500.00", holdings: 1 },
  defaultAnnualReturnPercent: "12",
  includedValueToday: "10500.00",
  scenarios: [scenario(5, { projectedValue: "824863.67" }), scenario(10)],
  curve: [
    { year: 0, principal: "10500.00", projectedValue: "10500.00" },
    { year: 5, principal: "610500.00", projectedValue: "824863.67" },
  ],
  holdings: [{ id: "h1", name: "Nifty 50 Index Fund", type: "MUTUAL_FUND", currentValue: "10500.00", annualReturnPercent: "12", rateSource: "DEFAULT", contributionPerPeriod: null, frequency: null, included: true }],
  includedCount: 1,
  excludedCount: 0,
  ...over,
});
