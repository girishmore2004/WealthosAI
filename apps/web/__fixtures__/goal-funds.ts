// API-shaped fixtures for the Money → Goals tests. The emergency fund carries the spec's own numbers: ₹82,000 in
// the fund, essential expenses ₹25,000 a month, target 6 months = ₹1,50,000, so ₹68,000 to go, 54.7%, 3.28 months.

export const EF_RULES = {
  typeLabel: "Emergency fund",
  balanceLabel: "In your fund",
  supportsCoverage: true,
  supportsMonthsTarget: true,
  spendModes: ["EXPENSE"],
  defaultSpendMode: "EXPENSE",
  addSources: ["Monthly contribution", "Bonus", "Extra savings", "Salary allocation"],
  useReasons: ["Medical emergency", "Job loss", "Urgent repair", "Family emergency"],
};

export const HOUSE_RULES = {
  typeLabel: "House",
  balanceLabel: "Saved so far",
  supportsCoverage: false,
  supportsMonthsTarget: false,
  spendModes: ["OTHER_OUTFLOW", "EXPENSE"],
  defaultSpendMode: "OTHER_OUTFLOW",
  addSources: ["Monthly contribution", "Bonus", "Extra savings", "Salary allocation"],
  useReasons: ["Down payment", "Registration & stamp duty", "Interiors", "Part payment"],
};

export const RETIREMENT_RULES = {
  typeLabel: "Retirement",
  balanceLabel: "Saved so far",
  supportsCoverage: false,
  supportsMonthsTarget: false,
  spendModes: [],
  defaultSpendMode: null,
  addSources: ["Monthly contribution"],
  useReasons: ["Returned to cash"],
};

const basePlan = {
  basis: "ESTIMATED",
  monthlyContribution: "10000.00",
  targetDate: "2027-04-03T00:00:00.000Z",
  requiredMonthly: "11333.33",
  requiredWeekly: "2615.38",
  monthsToTargetAtPlan: 7,
  estimatedFinishDate: "2027-05-12T00:00:00.000Z",
};

/** The emergency fund (reserve-backed) overview. */
export const overview = (over: Record<string, any> = {}): any => ({
  basis: "ACTUAL",
  currency: "INR",
  balance: "82000.00",
  coverage: { months: "3.28", avgMonthlyEssentialExpenses: "25000.00", monthsOfData: 3 },
  target: { basis: "TARGET", mode: "MONTHS", amount: "150000.00", months: "6", needsExpenseHistory: false },
  progress: { percent: 54.7, remaining: "68000.00", reached: false },
  plan: basePlan,
  totals: { contributions: "85000.00", withdrawals: "3000.00", adjustments: "0.00", contributedThisMonth: "7000.00", contributedThisYear: "85000.00", withdrawnThisYear: "3000.00" },
  last: { contribution: { date: "2026-10-01T00:00:00.000Z", amount: "7000.00" }, withdrawal: { date: "2026-09-10T00:00:00.000Z", amount: "3000.00" } },
  trend: [
    { month: "2026-09", closingBalance: "75000.00", added: "0.00", used: "3000.00" },
    { month: "2026-10", closingBalance: "82000.00", added: "7000.00", used: "0.00" },
  ],
  entryCount: 3,
  goal: { id: "g-ef", name: "Emergency fund", type: "EMERGENCY_FUND", backing: "RESERVE", archived: false, hasTargetDate: true, createdAt: "2026-01-01T00:00:00.000Z" },
  rules: EF_RULES,
  funding: { cashBalance: "82000.00", linkedInvestmentValue: "0.00", totalFunded: "82000.00", linkedInvestments: [] },
  status: { probabilityOfSuccess: "AT_RISK", contributionPaceRatio: 0.88, isPaceHeuristic: true, requiredMonthlyWithGrowth: 11333.33, assumedAnnualReturnPercent: "0.00" },
  ...over,
});

/** A non-emergency goal (its own ledger, a fixed target amount, no coverage). */
export const houseOverview = (over: Record<string, any> = {}): any =>
  overview({
    balance: "105000.00",
    coverage: null,
    target: { basis: "TARGET", mode: "AMOUNT", amount: "2000000.00", months: null, needsExpenseHistory: false },
    progress: { percent: 5.3, remaining: "1895000.00", reached: false },
    plan: { ...basePlan, monthlyContribution: "30000.00", requiredMonthly: "52638.89", requiredWeekly: "12150.00", monthsToTargetAtPlan: 64, targetDate: "2031-01-01T00:00:00.000Z" },
    totals: { contributions: "105000.00", withdrawals: "0.00", adjustments: "0.00", contributedThisMonth: "5000.00", contributedThisYear: "105000.00", withdrawnThisYear: "0.00" },
    last: { contribution: { date: "2026-10-01T00:00:00.000Z", amount: "5000.00" }, withdrawal: null },
    entryCount: 2,
    goal: { id: "g-house", name: "House", type: "HOUSE", backing: "GOAL_LEDGER", archived: false, hasTargetDate: true, createdAt: "2026-02-01T00:00:00.000Z" },
    rules: HOUSE_RULES,
    funding: { cashBalance: "105000.00", linkedInvestmentValue: "0.00", totalFunded: "105000.00", linkedInvestments: [] },
    ...over,
  });

export const fund = (over: Record<string, any> = {}): any => ({
  id: "g-ef",
  name: "Emergency fund",
  type: "EMERGENCY_FUND",
  backing: "RESERVE",
  archived: false,
  cashBalance: "82000.00",
  linkedInvestmentValue: "0.00",
  totalFunded: "82000.00",
  targetAmount: "150000.00",
  shortfall: "68000.00",
  progressPercent: 54.7,
  reached: false,
  targetDate: "2027-04-03T00:00:00.000Z",
  monthlyContribution: "10000.00",
  requiredMonthlyContribution: 11333.33,
  probabilityOfSuccess: "AT_RISK",
  entryCount: 3,
  ...over,
});

export const houseFund = (over: Record<string, any> = {}): any =>
  fund({ id: "g-house", name: "House", type: "HOUSE", backing: "GOAL_LEDGER", cashBalance: "105000.00", totalFunded: "105000.00", targetAmount: "2000000.00", shortfall: "1895000.00", progressPercent: 5.3, entryCount: 2, ...over });

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
