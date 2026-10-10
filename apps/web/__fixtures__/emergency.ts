// API-shaped fixtures for the emergency-fund tests. The spec's own numbers: ₹82,000 in the fund,
// essential expenses ₹25,000 a month, target 6 months = ₹1,50,000, so ₹68,000 to go, 54.7%, 3.28 months.
export const overview = (over: Record<string, any> = {}): any => ({
  basis: "ACTUAL",
  currency: "INR",
  balance: "82000.00",
  coverage: { months: "3.28", avgMonthlyEssentialExpenses: "25000.00", monthsOfData: 3 },
  target: { basis: "TARGET", mode: "MONTHS", amount: "150000.00", months: "6", needsExpenseHistory: false },
  progress: { percent: 54.7, remaining: "68000.00", reached: false },
  plan: {
    basis: "ESTIMATED",
    monthlyContribution: "10000.00",
    targetDate: "2027-04-03T00:00:00.000Z",
    requiredMonthly: "11333.33",
    requiredWeekly: "2615.38",
    monthsToTargetAtPlan: 7,
    estimatedFinishDate: "2027-05-12T00:00:00.000Z",
  },
  totals: { contributions: "85000.00", withdrawals: "3000.00", adjustments: "0.00", contributedThisMonth: "7000.00", contributedThisYear: "85000.00", withdrawnThisYear: "3000.00" },
  last: { contribution: { date: "2026-10-01T00:00:00.000Z", amount: "7000.00" }, withdrawal: { date: "2026-09-10T00:00:00.000Z", amount: "3000.00" } },
  trend: [
    { month: "2026-09", closingBalance: "75000.00", added: "0.00", used: "3000.00" },
    { month: "2026-10", closingBalance: "82000.00", added: "7000.00", used: "0.00" },
  ],
  entryCount: 3,
  ...over,
});

export const ledgerRow = (over: Record<string, any> = {}): any => ({
  id: "e1",
  type: "ALLOCATE",
  amount: "7000.00",
  effect: "7000.00",
  balanceAfter: "82000.00",
  occurredAt: "2026-10-01T00:00:00.000Z",
  reason: "Monthly contribution",
  notes: null,
  origin: "MANUAL",
  ...over,
});

export const categories = (): any[] => [
  { id: "med", name: "Medical", type: "NEED", icon: null, isSystem: true },
  { id: "rep", name: "Repairs", type: "NEED", icon: null, isSystem: true },
  { id: "sip", name: "SIP Investment", type: "SAVINGS", icon: null, isSystem: true },
];
