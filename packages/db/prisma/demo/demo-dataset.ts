// WealthOS AI - demo dataset generator.
//
// Builds ONE consistent, believable financial life, month by month, for the 84 months (7 years)
// ending at `asOf`. It is a PURE function: no database, no Prisma, no clock. The same `asOf`
// always produces exactly the same rows, so the numbers on the dashboard, in the reports and in
// the AI Coach can be checked against this file.
//
// THE PERSON
//   Aarav Sharma, 33, software engineer in Nagpur, Maharashtra. Joined his first job in
//   Oct 2019 at 8 LPA, now 25 LPA CTC (7 years of experience, one job switch). Married Dec 2022
//   (wife Priya), daughter Ira born Mar 2025, supports his parents. Runs a small design/web
//   studio on the side since Feb 2022. Bought a 2BHK flat in Aug 2024 with a home loan and a car
//   in Jun 2023 with a car loan.
//
// HOW THE APP'S NUMBERS ARE BUILT (so the data has to be recorded the same way)
//   * Income is recorded as money that reached the bank (in-hand salary after PF, professional
//     tax and TDS). Employee + employer PF go straight into the EPF holding.
//   * Available cash = all income - all spending - money put into investments + money taken out
//     of investments - money moved into the emergency reserve - other outflows (down payments,
//     money lent) + money lent that came back.   There is no "opening balance", so every rupee
//     in the bank has to be explained by recorded history. This file does that: cash never goes
//     negative at any point in the 7 years (the tests check it day by day).
//   * Net worth = cash + emergency reserve + investments + property + money lent out - loans.
//   * EMI is recorded as an expense (category "EMI"). Loan principal outstanding is reduced
//     month by month by the real amortisation schedule.
//   * Large purchases that are not spending (house/car down payment, registration) are
//     "other outflows" so they never inflate the expense rate.
//   * Recurring income uses the app's own convention: the LATEST row of a series is the recurring
//     template, earlier rows point at it (generatedFromRecurringId). Only the template feeds the
//     monthly forecast, so the forecast is one salary, not 84.
//
// MARKET RETURNS are an ILLUSTRATIVE path (shaped like an Indian equity index: the Mar 2020 fall,
// the 2020-21 recovery, 2022 chop, 2024 highs) and are not real index data.
// All names of banks, insurers and companies are fictional. TDS uses simplified new-regime
// slabs per financial year; it is an approximation for the demo, not tax advice.

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type DemoPayment = "CASH" | "UPI" | "CARD" | "BANK_TRANSFER" | "WALLET" | "OTHER";
export type DemoRecurrence = "ONE_TIME" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

export interface DemoCategory {
  name: string;
  type: "NEED" | "WANT" | "SAVINGS";
  icon: string;
}

export interface DemoIncome {
  key: string;
  source: "SALARY" | "BUSINESS" | "BONUS" | "INTEREST" | "DIVIDEND" | "OTHER";
  label: string;
  amount: number;
  receivedAt: Date;
  recurrence: DemoRecurrence;
  /** Key of the recurring template this row repeats (the latest row of the series is the template). */
  templateKey: string | null;
  /** Business transaction this row was synced from (owner drawings). */
  businessTransactionKey: string | null;
  notes: string | null;
}

export interface DemoExpense {
  categoryName: string;
  merchant: string;
  amount: number;
  spentAt: Date;
  paymentMethod: DemoPayment;
  notes: string | null;
  isRecurring: boolean;
  flowType: "EXPENSE" | "OTHER_OUTFLOW";
  /** Insurance premium paid for this policy (links the expense to it, as the Insurance page does). */
  policyKey?: string | null;
  /** Premium period, e.g. "2026" for a yearly policy. */
  sourceReference?: string | null;
}

export type DemoInvestmentType = "MUTUAL_FUND" | "STOCK" | "EPF" | "PPF" | "NPS" | "FD" | "GOLD";

export interface DemoInvestment {
  key: string;
  type: DemoInvestmentType;
  name: string;
  currentValue: number;
  costBasis: number;
  purchaseDate: Date;
  riskLevel: "LOW" | "MODERATE" | "HIGH";
  liquidity: "LIQUID" | "SEMI_LIQUID" | "ILLIQUID";
  goalKey: string | null;
  notes: string | null;
  sipActive: boolean;
  monthlyContribution: number | null;
  contributionDay: number | null;
  contributionStartDate: Date | null;
  expectedAnnualReturn: number;
}

export interface DemoCashflow {
  investmentKey: string;
  type: "CONTRIBUTION" | "WITHDRAWAL" | "EMPLOYER_CONTRIBUTION";
  amount: number;
  occurredAt: Date;
  periodKey: string | null;
  notes: string | null;
}

export interface DemoValuation {
  investmentKey: string;
  value: number;
  valuedAt: Date;
}

export interface DemoEmergencyEntry {
  type: "ALLOCATE" | "WITHDRAWAL";
  amount: number;
  occurredAt: Date;
  reason: string | null;
  notes: string | null;
}

export interface DemoLoan {
  key: string;
  type: "HOME" | "CAR";
  lender: string;
  principal: number;
  outstandingPrincipal: number;
  interestRateAnnual: number;
  tenureMonths: number;
  emiAmount: number;
  startDate: Date;
  notes: string | null;
}

export interface DemoProperty {
  key: string;
  type: "APARTMENT";
  name: string;
  address: string;
  currentValue: number;
  purchasePrice: number;
  purchaseDate: Date;
  annualMaintenanceCost: number;
  annualPropertyTax: number;
  loanKey: string;
  policyKey: string;
  notes: string | null;
}

export interface DemoPolicy {
  key: string;
  type: "HEALTH" | "TERM" | "VEHICLE" | "HOME" | "PERSONAL_ACCIDENT" | "CRITICAL_ILLNESS" | "BUSINESS";
  provider: string;
  policyNumber: string;
  premiumAmount: number;
  premiumFrequency: "YEARLY";
  coverageAmount: number;
  renewalDate: Date;
  nomineeName: string;
  nomineeDependentName: string | null;
  notes: string | null;
}

export interface DemoDependent {
  name: string;
  relation: string;
  dateOfBirth: Date;
}

export interface DemoBusiness {
  name: string;
  description: string;
  entityType: "SOLE_PROPRIETORSHIP";
  startedAt: Date;
  ownershipPercent: number;
}

export interface DemoBusinessTransaction {
  key: string;
  type: "REVENUE" | "EXPENSE" | "OWNER_DRAWING";
  category: string;
  amount: number;
  occurredAt: Date;
  description: string;
  isRecurring: boolean;
}

export interface DemoBusinessObligation {
  title: string;
  dueDate: Date;
  amount: number | null;
  recurrence: DemoRecurrence;
  vendor: string | null;
  status: "PENDING" | "PAID";
  notes: string | null;
}

export interface DemoGoal {
  key: string;
  type: "EMERGENCY_FUND" | "RETIREMENT" | "CHILD_EDUCATION" | "VACATION";
  name: string;
  targetAmount: number;
  targetDate: Date;
  currentAmount: number;
  monthlyContribution: number;
  assumedAnnualReturnPercent: number | null;
}

export interface DemoReceivable {
  person: string;
  purpose: string;
  originalAmount: number;
  givenAt: Date;
  expectedReturnAt: Date;
  status: "OUTSTANDING" | "PARTIALLY_RETURNED" | "FULLY_RETURNED";
  paymentMethod: DemoPayment;
  notes: string | null;
  repayments: { amount: number; returnedAt: Date; notes: string | null }[];
}

export interface DemoTransfer {
  fromAccount: string;
  toAccount: string;
  amount: number;
  transferredAt: Date;
  notes: string | null;
}

export interface DemoTaxDeduction {
  section: "SECTION_80C" | "SECTION_80D" | "SECTION_80CCD_1B" | "HOME_LOAN_INTEREST";
  description: string;
  amount: number;
  financialYear: string;
}

export interface DemoDataset {
  asOf: Date;
  startMonth: string;
  endMonth: string;
  persona: { name: string; dateOfBirth: Date; city: string };
  household: { name: string };
  dependents: DemoDependent[];
  categories: DemoCategory[];
  incomes: DemoIncome[];
  expenses: DemoExpense[];
  investments: DemoInvestment[];
  cashflows: DemoCashflow[];
  valuations: DemoValuation[];
  emergencyEntries: DemoEmergencyEntry[];
  emergencyPlan: { targetMonths: number; monthlyContribution: number; targetDate: Date };
  loans: DemoLoan[];
  properties: DemoProperty[];
  policies: DemoPolicy[];
  business: DemoBusiness;
  businessTransactions: DemoBusinessTransaction[];
  businessObligations: DemoBusinessObligation[];
  goals: DemoGoal[];
  receivables: DemoReceivable[];
  transfers: DemoTransfer[];
  taxDeductions: DemoTaxDeduction[];
  retirement: {
    targetRetirementAge: number;
    desiredMonthlyIncomeToday: number;
    inflationRatePercent: number;
    expectedReturnPreRetirementPercent: number;
    expectedReturnPostRetirementPercent: number;
    lifeExpectancyAge: number;
  };
  budgets: { categoryName: string; monthlyAmount: number }[];
  /** Facts about the story, for the seed script's summary and for tests. */
  facts: {
    currentCtc: number;
    currentMonthlyNetSalary: number;
    months: number;
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** 12:00 IST on the given UTC calendar day (06:30Z), so the day is the same in India and UTC. */
const at = (y: number, m0: number, d: number, h = 6, mi = 30): Date => new Date(Date.UTC(y, m0, d, h, mi));
const daysIn = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const clampDay = (y: number, m0: number, d: number) => Math.min(d, daysIn(y, m0));
const r2 = (n: number) => Math.round(n * 100) / 100;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const floorTo = (n: number, step: number) => Math.floor(n / step) * step;
const ceilTo = (n: number, step: number) => Math.ceil(n / step) * step;
const pad2 = (n: number) => String(n).padStart(2, "0");
const ym = (y: number, m0: number) => `${y}-${pad2(m0 + 1)}`;
const monthIndex = (y: number, m0: number) => y * 12 + m0;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Indian financial year label for a calendar month: Apr 2026 -> "2026-27". */
export const financialYearOf = (y: number, m0: number): string => {
  const s = m0 >= 3 ? y : y - 1;
  return `${s}-${pad2((s + 1) % 100)}`;
};
const fyStartYear = (y: number, m0: number) => (m0 >= 3 ? y : y - 1);

// ---------------------------------------------------------------------------------------------
// Salary: CTC history, take-home and simplified TDS
// ---------------------------------------------------------------------------------------------

// [year, month0, annual CTC in rupees]. The Jul 2023 step is the job switch.
const CTC_HISTORY: [number, number, number][] = [
  [2019, 9, 800_000],
  [2021, 3, 1_000_000],
  [2022, 3, 1_250_000],
  [2023, 6, 1_800_000],
  [2024, 3, 2_000_000],
  [2025, 3, 2_250_000],
  [2026, 3, 2_500_000],
];
const VARIABLE_PCT = 0.08; // performance pay, paid every May for the year just ended
const EMPLOYER_PF_PCT = 0.048; // 12% of a basic that is 40% of CTC
const OTHER_BENEFITS_PCT = 0.012; // gratuity + group cover, never reaches the bank
const FIXED_CASH_PCT = 1 - VARIABLE_PCT - EMPLOYER_PF_PCT - OTHER_BENEFITS_PCT;

const ctcAt = (y: number, m0: number): number => {
  let ctc = CTC_HISTORY[0][2];
  for (const [cy, cm, v] of CTC_HISTORY) if (monthIndex(y, m0) >= monthIndex(cy, cm)) ctc = v;
  return ctc;
};

type Slab = [limit: number, rate: number];
interface TaxYear {
  slabs: Slab[];
  standardDeduction: number;
  rebateLimit: number;
}
const slabsTax = (taxable: number, slabs: Slab[]): number => {
  let tax = 0;
  let prev = 0;
  for (const [limit, rate] of slabs) {
    if (taxable > prev) tax += (Math.min(taxable, limit) - prev) * rate;
    prev = limit;
  }
  return tax;
};
const TAX_EARLY: TaxYear = {
  slabs: [[250_000, 0], [500_000, 0.05], [750_000, 0.1], [1_000_000, 0.15], [1_250_000, 0.2], [1_500_000, 0.25], [Infinity, 0.3]],
  standardDeduction: 0,
  rebateLimit: 500_000,
};
const TAX_FY2324: TaxYear = {
  slabs: [[300_000, 0], [600_000, 0.05], [900_000, 0.1], [1_200_000, 0.15], [1_500_000, 0.2], [Infinity, 0.3]],
  standardDeduction: 50_000,
  rebateLimit: 700_000,
};
const TAX_FY2425: TaxYear = {
  slabs: [[300_000, 0], [700_000, 0.05], [1_000_000, 0.1], [1_200_000, 0.15], [1_500_000, 0.2], [Infinity, 0.3]],
  standardDeduction: 75_000,
  rebateLimit: 700_000,
};
const TAX_FY2526: TaxYear = {
  slabs: [[400_000, 0], [800_000, 0.05], [1_200_000, 0.1], [1_600_000, 0.15], [2_000_000, 0.2], [2_400_000, 0.25], [Infinity, 0.3]],
  standardDeduction: 75_000,
  rebateLimit: 1_200_000,
};
const taxYearFor = (fyStart: number): TaxYear =>
  fyStart <= 2022 ? TAX_EARLY : fyStart === 2023 ? TAX_FY2324 : fyStart === 2024 ? TAX_FY2425 : TAX_FY2526;

/** Annual income tax incl. 4% cess on a gross taxable salary (simplified new regime). */
const annualTax = (fyStart: number, grossTaxable: number): number => {
  const ty = taxYearFor(fyStart);
  const taxable = Math.max(0, grossTaxable - ty.standardDeduction);
  const base = taxable <= ty.rebateLimit ? 0 : slabsTax(taxable, ty.slabs);
  return base * 1.04;
};

interface SalaryMonth {
  net: number;
  employeePf: number;
  employerPf: number;
  grossMonthly: number;
  tds: number;
}
const salaryFor = (y: number, m0: number): SalaryMonth => {
  const ctc = ctcAt(y, m0);
  const fixedAnnual = ctc * FIXED_CASH_PCT;
  const grossMonthly = fixedAnnual / 12;
  const employeePf = (ctc * EMPLOYER_PF_PCT) / 12;
  const employerPf = employeePf;
  const professionalTax = 200;
  const tds = annualTax(fyStartYear(y, m0), fixedAnnual) / 12;
  return {
    net: Math.round(grossMonthly - employeePf - professionalTax - tds),
    employeePf: Math.round(employeePf),
    employerPf: Math.round(employerPf),
    grossMonthly: Math.round(grossMonthly),
    tds: Math.round(tds),
  };
};

// ---------------------------------------------------------------------------------------------
// Illustrative market path (percent per month), Oct 2019 onwards
// ---------------------------------------------------------------------------------------------

const EQUITY_PATH_START = monthIndex(2019, 9);
const EQUITY_PATH_PCT = [
  3.5, 1.5, 1.1, // 2019 Oct-Dec
  -1.7, -6.4, -23.3, 14.7, -2.8, 7.5, 7.5, 2.8, -1.2, 3.5, 11.4, 7.8, // 2020
  -2.4, 6.6, 1.1, -0.4, 6.5, 0.9, 0.3, 8.7, 2.8, -0.3, -3.9, 2.2, // 2021
  -0.1, -3.1, 4.0, -2.1, -3.0, -4.8, 8.7, 3.5, -3.7, 5.4, 4.1, -3.5, // 2022
  -2.4, -2.0, 0.3, 4.1, 2.6, 3.5, 2.9, -2.5, 2.0, -2.8, 5.5, 7.9, // 2023
  0.0, 1.2, 1.6, 1.2, -0.3, 6.6, 3.9, 1.1, 2.3, -6.2, -0.3, -2.0, // 2024
  -0.6, -5.9, 6.3, 3.5, 1.7, 3.1, -2.9, -1.4, 0.8, 4.5, 1.9, -0.3, // 2025
];

const EPF_RATE_BY_FY: Record<number, number> = { 2019: 8.5, 2020: 8.5, 2021: 8.1, 2022: 8.15, 2023: 8.25, 2024: 8.25, 2025: 8.25 };
const epfRate = (fyStart: number) => EPF_RATE_BY_FY[fyStart] ?? 8.25;
const ppfRate = (y: number, m0: number) => (monthIndex(y, m0) < monthIndex(2020, 3) ? 7.9 : 7.1);

// ---------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------

const CATEGORIES: DemoCategory[] = [
  { name: "Groceries", type: "NEED", icon: "shopping-cart" },
  { name: "Rent", type: "NEED", icon: "home" },
  { name: "Utilities", type: "NEED", icon: "zap" },
  { name: "EMI", type: "NEED", icon: "credit-card" },
  { name: "Transport", type: "NEED", icon: "car" },
  { name: "Healthcare", type: "NEED", icon: "heart" },
  { name: "Dining Out", type: "WANT", icon: "utensils" },
  { name: "Entertainment", type: "WANT", icon: "film" },
  { name: "Shopping", type: "WANT", icon: "bag" },
  { name: "Travel", type: "WANT", icon: "plane" },
  { name: "SIP Investment", type: "SAVINGS", icon: "trending-up" },
  { name: "Emergency Fund", type: "SAVINGS", icon: "shield" },
  // Added for this life story. Created only if missing, so existing databases keep working.
  { name: "Insurance", type: "NEED", icon: "shield" },
  { name: "Subscriptions", type: "WANT", icon: "repeat" },
  { name: "Childcare", type: "NEED", icon: "baby" },
  { name: "Family Support", type: "NEED", icon: "users" },
  { name: "Gifts & Festivals", type: "WANT", icon: "gift" },
  { name: "Personal Care", type: "WANT", icon: "smile" },
  { name: "Education", type: "NEED", icon: "book" },
  { name: "Housing", type: "NEED", icon: "building" },
  { name: "Home & Furnishing", type: "NEED", icon: "sofa" },
  { name: "Household Help", type: "NEED", icon: "broom" },
  { name: "Asset Purchase", type: "NEED", icon: "key" },
];

// ---------------------------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------------------------

const MONTHS = 84;

interface InvState {
  key: string;
  value: number;
  costBasis: number;
  started: boolean;
}

/** Standard EMI for a reducing-balance loan, rounded to the rupee. */
export const emiFor = (principal: number, annualRatePct: number, months: number): number => {
  const r = annualRatePct / 12 / 100;
  const f = Math.pow(1 + r, months);
  return Math.round((principal * r * f) / (f - 1));
};

export function buildDemoDataset(asOf: Date): DemoDataset {
  const rand = mulberry32(20191015);
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const jitter = (spread: number) => 1 + (rand() * 2 - 1) * spread;

  const asOfY = asOf.getUTCFullYear();
  const asOfM = asOf.getUTCMonth();
  const endIdx = monthIndex(asOfY, asOfM);
  const startIdx = endIdx - (MONTHS - 1);
  const isCurrentMonth = (y: number, m0: number) => monthIndex(y, m0) === endIdx;
  const monthFraction = (y: number, m0: number) =>
    isCurrentMonth(y, m0) ? Math.min(1, asOf.getUTCDate() / daysIn(y, m0)) : 1;

  const incomes: DemoIncome[] = [];
  const expenses: DemoExpense[] = [];
  const cashflows: DemoCashflow[] = [];
  const valuations: DemoValuation[] = [];
  const emergencyEntries: DemoEmergencyEntry[] = [];
  const businessTransactions: DemoBusinessTransaction[] = [];

  // Running available cash in paise (integers, so there is no float drift).
  let cashPaise = 0;
  const bump = (rupees: number) => {
    cashPaise += Math.round(rupees * 100);
  };
  const cash = () => cashPaise / 100;
  let emergencyBalance = 0;
  let incomeKeySeq = 0;
  let businessKeySeq = 0;

  const within = (d: Date) => d.getTime() <= asOf.getTime();

  // ---- recording primitives (each one keeps the running cash in step) ----------------------
  const addIncome = (i: Omit<DemoIncome, "key" | "templateKey" | "businessTransactionKey"> & { businessTransactionKey?: string | null }) => {
    if (!within(i.receivedAt)) return null;
    const key = `inc-${++incomeKeySeq}`;
    incomes.push({ ...i, key, templateKey: null, businessTransactionKey: i.businessTransactionKey ?? null });
    bump(i.amount);
    return key;
  };
  const addExpense = (e: DemoExpense) => {
    if (!within(e.spentAt) || e.amount <= 0) return;
    expenses.push({ ...e, amount: r2(e.amount) });
    bump(-e.amount);
  };
  const addCashflow = (c: DemoCashflow) => {
    if (!within(c.occurredAt) || c.amount <= 0) return false;
    cashflows.push({ ...c, amount: r2(c.amount) });
    if (c.type === "CONTRIBUTION") bump(-c.amount);
    if (c.type === "WITHDRAWAL") bump(c.amount);
    return true;
  };
  const addEmergency = (e: DemoEmergencyEntry) => {
    if (!within(e.occurredAt) || e.amount <= 0) return;
    emergencyEntries.push({ ...e, amount: r2(e.amount) });
    if (e.type === "ALLOCATE") {
      emergencyBalance += e.amount;
      bump(-e.amount);
    } else {
      emergencyBalance -= e.amount;
      bump(e.amount);
    }
  };

  // ---- investments -------------------------------------------------------------------------
  const inv: Record<string, InvState> = {};
  const defs: Omit<DemoInvestment, "currentValue" | "costBasis" | "purchaseDate" | "sipActive" | "monthlyContribution" | "contributionDay" | "contributionStartDate">[] = [
    { key: "idx", type: "MUTUAL_FUND", name: "Nifty 50 Index Fund (Direct)", riskLevel: "MODERATE", liquidity: "LIQUID", goalKey: "retirement", notes: "Monthly SIP, stepped up every April", expectedAnnualReturn: 12 },
    { key: "flexi", type: "MUTUAL_FUND", name: "Flexi Cap Fund (Direct)", riskLevel: "MODERATE", liquidity: "LIQUID", goalKey: "education", notes: "Monthly SIP for Ira's education", expectedAnnualReturn: 12.5 },
    { key: "small", type: "MUTUAL_FUND", name: "Small Cap Fund (Direct)", riskLevel: "HIGH", liquidity: "LIQUID", goalKey: null, notes: "Small satellite position, 7+ year horizon", expectedAnnualReturn: 14 },
    { key: "stocks", type: "STOCK", name: "Direct Equity - Blue-chip Basket", riskLevel: "HIGH", liquidity: "LIQUID", goalKey: null, notes: "Lump sums after each annual bonus", expectedAnnualReturn: 12 },
    { key: "epf", type: "EPF", name: "Employees' Provident Fund", riskLevel: "LOW", liquidity: "ILLIQUID", goalKey: "retirement", notes: "Employee + employer share, deducted from salary", expectedAnnualReturn: 8.25 },
    { key: "ppf", type: "PPF", name: "Public Provident Fund", riskLevel: "LOW", liquidity: "ILLIQUID", goalKey: "retirement", notes: "Rs 50,000 every March", expectedAnnualReturn: 7.1 },
    { key: "nps", type: "NPS", name: "National Pension System (Tier I)", riskLevel: "MODERATE", liquidity: "ILLIQUID", goalKey: "retirement", notes: "Voluntary Rs 3,000 a month since Apr 2022", expectedAnnualReturn: 10 },
    { key: "fd", type: "FD", name: "Bank Fixed Deposit (3 years)", riskLevel: "LOW", liquidity: "SEMI_LIQUID", goalKey: null, notes: "Opened with part of the 2025 bonus", expectedAnnualReturn: 7.1 },
    { key: "gold", type: "GOLD", name: "Gold ETF", riskLevel: "MODERATE", liquidity: "LIQUID", goalKey: null, notes: "Rs 25,000 each Akshaya Tritiya", expectedAnnualReturn: 8 },
  ];
  for (const d of defs) inv[d.key] = { key: d.key, value: 0, costBasis: 0, started: false };
  const firstPurchase: Record<string, Date> = {};
  const returnPct = (y: number, m0: number, kind: string): number => {
    const idx = monthIndex(y, m0) - EQUITY_PATH_START;
    const base = idx >= 0 && idx < EQUITY_PATH_PCT.length ? EQUITY_PATH_PCT[idx] : between(-3.2, 4.6);
    const noise = (rand() * 2 - 1) * 0.6;
    switch (kind) {
      case "idx": return base;
      case "flexi": return base * 0.95 + 0.12 + noise * 0.5;
      case "small": return base * 1.3 + noise * 1.4;
      case "stocks": return base * 1.05 + noise * 1.6;
      case "nps": return base * 0.55 + 0.38;
      case "gold": return 0.62 + (rand() * 2 - 1) * 2.4;
      case "epf": return epfRate(fyStartYear(y, m0)) / 12;
      case "ppf": return ppfRate(y, m0) / 12;
      case "fd": return 7.1 / 12;
      default: return 0;
    }
  };
  const contribute = (key: string, amount: number, date: Date, periodKey: string | null, notes: string | null, type: "CONTRIBUTION" | "EMPLOYER_CONTRIBUTION" = "CONTRIBUTION") => {
    const a = r2(amount);
    if (!addCashflow({ investmentKey: key, type, amount: a, occurredAt: date, periodKey, notes })) return;
    inv[key].value += a;
    inv[key].costBasis += a;
    if (!inv[key].started) {
      inv[key].started = true;
      firstPurchase[key] = date;
    }
  };
  const redeem = (key: string, amount: number, date: Date, notes: string): number => {
    const s = inv[key];
    const take = r2(Math.min(amount, Math.floor(s.value * 0.9)));
    if (take <= 0) return 0;
    const portion = take / s.value;
    s.costBasis = r2(s.costBasis - s.costBasis * portion);
    s.value = r2(s.value - take);
    addCashflow({ investmentKey: key, type: "WITHDRAWAL", amount: take, occurredAt: date, periodKey: null, notes });
    return take;
  };
  /** Raise `needed` rupees of cash by redeeming holdings, most liquid and least risky first. */
  const raiseCash = (needed: number, date: Date, why: string) => {
    let left = ceilTo(needed, 5_000);
    for (const k of ["idx", "flexi", "stocks", "small", "gold", "fd"]) {
      if (left <= 0) break;
      left -= redeem(k, left, date, why);
    }
    if (left > 5_000) throw new Error(`Demo story is not fundable: still short by ${left} for ${why} on ${date.toISOString()}`);
  };

  // ---- recurring-series bookkeeping --------------------------------------------------------
  const seriesBySource: Record<string, DemoIncome[]> = {};
  const trackSeries = (name: string, key: string | null) => {
    if (!key) return;
    (seriesBySource[name] ??= []).push(incomes.find((x) => x.key === key)!);
  };

  // ---- housing & loans timeline ------------------------------------------------------------
  const rentFor = (y: number, m0: number): number | null => {
    const i = monthIndex(y, m0);
    if (i < monthIndex(2021, 3)) return 9_000;
    if (i < monthIndex(2022, 3)) return 11_500;
    if (i < monthIndex(2022, 11)) return 12_000;
    if (i < monthIndex(2023, 11)) return 18_000;
    if (i < monthIndex(2024, 9)) return 19_000;
    return null; // owns the flat from Oct 2024
  };
  const CAR_LOAN = { principal: 650_000, rate: 9.25, months: 60, start: monthIndex(2023, 6) }; // first EMI 5 Jul 2023
  const FLAT_PRICE = 4_400_000;
  const HOME_LOAN = { principal: 3_520_000, rate: 8.5, months: 240, start: monthIndex(2024, 9) }; // first EMI 5 Oct 2024
  const carEmi = emiFor(CAR_LOAN.principal, CAR_LOAN.rate, CAR_LOAN.months);
  const homeEmi = emiFor(HOME_LOAN.principal, HOME_LOAN.rate, HOME_LOAN.months);
  const balance = { car: CAR_LOAN.principal, home: HOME_LOAN.principal };
  const interestPaidByFy: Record<string, number> = {};

  // ---- living costs ------------------------------------------------------------------------
  // Monthly target at today's prices for a family of three, scaled back for earlier years
  // (6% a year inflation) and for a smaller household.
  const LIVING: { cat: string; target: number; stage: [number, number, number]; merchants: string[]; pay: DemoPayment[]; items: [number, number]; seasonal?: (m0: number) => number }[] = [
    { cat: "Groceries", target: 11_500, stage: [0.55, 0.85, 1], merchants: ["BigBasket", "DMart", "Local vegetable market", "Reliance Smart"], pay: ["UPI", "CARD", "UPI", "UPI"], items: [4, 6] },
    { cat: "Dining Out", target: 4_500, stage: [0.6, 0.9, 0.9], merchants: ["Zomato", "Swiggy", "Cafe Coffee Day", "Haldiram's"], pay: ["UPI", "UPI", "CARD", "UPI"], items: [3, 5] },
    { cat: "Transport", target: 5_000, stage: [0.85, 1, 1], merchants: ["Ola / Uber", "Metro & auto", "Petrol pump", "FASTag recharge"], pay: ["UPI", "UPI", "CARD", "UPI"], items: [3, 5] },
    { cat: "Utilities", target: 5_500, stage: [0.55, 0.9, 1], merchants: ["MSEDCL electricity", "Airtel / Jio mobile & broadband", "Cooking gas (HP Gas)", "Water & misc bills"], pay: ["UPI", "UPI", "UPI", "UPI"], items: [3, 4], seasonal: (m0) => (m0 >= 3 && m0 <= 5 ? 1.25 : m0 === 11 || m0 === 0 ? 0.92 : 1) },
    { cat: "Shopping", target: 4_000, stage: [0.6, 0.9, 1], merchants: ["Amazon", "Myntra", "Decathlon", "Local market"], pay: ["CARD", "CARD", "UPI", "UPI"], items: [2, 3], seasonal: (m0) => (m0 === 9 || m0 === 10 ? 1.9 : m0 === 0 ? 1.3 : 1) },
    { cat: "Entertainment", target: 2_000, stage: [0.7, 0.9, 0.9], merchants: ["PVR Cinemas", "BookMyShow", "Gaming & apps"], pay: ["UPI", "UPI", "CARD"], items: [1, 3] },
    { cat: "Healthcare", target: 2_000, stage: [0.35, 0.8, 1], merchants: ["Apollo Pharmacy", "MedPlus", "City Clinic"], pay: ["UPI", "UPI", "CASH"], items: [1, 3] },
    { cat: "Personal Care", target: 2_000, stage: [0.6, 0.9, 1], merchants: ["Salon & grooming", "Urban Company", "Nykaa"], pay: ["UPI", "UPI", "CARD"], items: [1, 2] },
  ];
  const stageOf = (y: number, m0: number): 0 | 1 | 2 => {
    const i = monthIndex(y, m0);
    return i < monthIndex(2022, 11) ? 0 : i < monthIndex(2025, 2) ? 1 : 2;
  };
  const yearsBack = (y: number, m0: number) => Math.max(0, (endIdx - monthIndex(y, m0)) / 12);

  const subscriptions = (y: number, m0: number): { merchant: string; amount: number; day: number }[] => {
    const i = monthIndex(y, m0);
    const list: { merchant: string; amount: number; day: number }[] = [];
    list.push({ merchant: "Netflix", amount: i < monthIndex(2022, 5) ? 199 : i < monthIndex(2023, 6) ? 499 : 649, day: 12 });
    if (i >= monthIndex(2020, 2)) list.push({ merchant: "Spotify", amount: i < monthIndex(2024, 6) ? 119 : 139, day: 14 });
    if (i >= monthIndex(2021, 0)) list.push({ merchant: "Google One storage", amount: 130, day: 3 });
    if (i >= monthIndex(2021, 5)) list.push({ merchant: "Gym membership", amount: i < monthIndex(2024, 3) ? 1_500 : 2_000, day: 6 });
    if (i >= monthIndex(2023, 0)) list.push({ merchant: "YouTube Premium (family)", amount: 189, day: 20 });
    if (m0 === 10) list.push({ merchant: "Amazon Prime (annual)", amount: i < monthIndex(2022, 0) ? 999 : 1_499, day: 9 });
    return list;
  };

  const DIWALI: Record<number, [number, number]> = { 2019: [9, 27], 2020: [10, 14], 2021: [10, 4], 2022: [9, 24], 2023: [10, 12], 2024: [10, 1], 2025: [9, 20], 2026: [10, 8] };

  // One-off life events, dated and funded by the generator.
  const TRIPS: Record<string, [string, number]> = {
    "2019-12": ["Goa trip with college friends", 16_000],
    "2021-11": ["Kerala backwaters trip", 42_000],
    "2022-12": ["Honeymoon (Thailand)", 60_000],
    "2024-05": ["Manali family holiday", 45_000],
    "2025-10": ["Goa long weekend", 24_000],
    "2026-01": ["Jaipur and Udaipur family trip", 52_000],
  };
  const COURSES: Record<string, [string, number]> = {
    "2020-06": ["Data science certification (online)", 14_000],
    "2022-09": ["Cloud architect certification", 8_500],
    "2024-03": ["Management essentials program", 12_000],
  };
  const GADGETS: Record<string, [string, number]> = {
    "2021-11": ["Laptop (work + studio)", 72_000],
    "2022-10": ["Smartphone", 38_000],
    "2025-11": ["Smartphone upgrade", 35_000],
  };

  // ---- insurance ---------------------------------------------------------------------------
  interface PolicyPlan {
    key: string;
    type: DemoPolicy["type"];
    provider: string;
    coverage: number;
    startY: number;
    month0: number;
    day: number;
    firstPremium: number;
    growth: number;
    nominee: string;
    nomineeDependent: string | null;
    notes: string;
  }
  const POLICY_PLANS: PolicyPlan[] = [
    { key: "term", type: "TERM", provider: "Suraksha Life Insurance", coverage: 15_000_000, startY: 2021, month0: 2, day: 18, firstPremium: 16_500, growth: 0, nominee: "Priya Sharma", nomineeDependent: "Priya Sharma", notes: "Rs 1.5 crore term cover, level premium, runs to age 60" },
    { key: "health", type: "HEALTH", provider: "Arogya Health Insurance", coverage: 1_500_000, startY: 2022, month0: 6, day: 8, firstPremium: 12_500, growth: 0.07, nominee: "Priya Sharma", nomineeDependent: "Priya Sharma", notes: "Family floater: self, wife and daughter" },
    { key: "parents", type: "HEALTH", provider: "Arogya Health Insurance", coverage: 1_000_000, startY: 2021, month0: 10, day: 22, firstPremium: 24_000, growth: 0.07, nominee: "Suresh Sharma", nomineeDependent: "Suresh Sharma", notes: "Senior-citizen cover for parents" },
    { key: "car", type: "VEHICLE", provider: "Gati General Insurance", coverage: 590_000, startY: 2023, month0: 5, day: 20, firstPremium: 13_500, growth: -0.04, nominee: "Priya Sharma", nomineeDependent: "Priya Sharma", notes: "Comprehensive cover, no-claim bonus builds up" },
    { key: "pa", type: "PERSONAL_ACCIDENT", provider: "Gati General Insurance", coverage: 2_500_000, startY: 2022, month0: 0, day: 15, firstPremium: 2_450, growth: 0.03, nominee: "Priya Sharma", nomineeDependent: "Priya Sharma", notes: "Accidental death and disability" },
    { key: "ci", type: "CRITICAL_ILLNESS", provider: "Arogya Health Insurance", coverage: 2_500_000, startY: 2024, month0: 1, day: 10, firstPremium: 10_500, growth: 0.03, nominee: "Priya Sharma", nomineeDependent: "Priya Sharma", notes: "Lump-sum on diagnosis of 34 listed illnesses" },
    { key: "home", type: "HOME", provider: "Gati General Insurance", coverage: 4_400_000, startY: 2024, month0: 9, day: 12, firstPremium: 3_800, growth: 0.03, nominee: "Priya Sharma", nomineeDependent: "Priya Sharma", notes: "Structure cover for the flat" },
    { key: "biz", type: "BUSINESS", provider: "Suraksha Life Insurance", coverage: 1_000_000, startY: 2023, month0: 2, day: 25, firstPremium: 6_500, growth: 0, nominee: "Aarav Sharma", nomineeDependent: null, notes: "Professional indemnity for the studio" },
  ];
  const premiumFor = (p: PolicyPlan, year: number) => roundTo(p.firstPremium * Math.pow(1 + p.growth, year - p.startY), 10);
  const policyNumbers: Record<string, string> = { term: "SLI/T/21/448210", health: "AHI/F/22/771903", parents: "AHI/S/21/330518", car: "GGI/M/23/902114", pa: "GGI/PA/22/115670", ci: "AHI/CI/24/660231", home: "GGI/H/24/204487", biz: "SLI/B/23/310099" };

  // ---- side business -----------------------------------------------------------------------
  const BUSINESS_START = monthIndex(2022, 1);
  const bizMonth = (y: number, m0: number) => {
    const t = (monthIndex(y, m0) - BUSINESS_START) / 12; // years since start
    const growth = 14_000 + 21_000 * t; // reaches about 1 lakh in year 4
    const season = [1.05, 0.95, 1.1, 0.9, 0.85, 0.9, 0.95, 1, 1.05, 1.15, 1.1, 1.2][m0];
    return roundTo(growth * season * jitter(0.12), 500);
  };

  // ---- fixed events ------------------------------------------------------------------------
  const WEDDING = { y: 2022, m0: 11 };
  const CAR_BUY = { y: 2023, m0: 5 };
  const HOME_BUY = { y: 2024, m0: 7 };
  const HOSPITAL_1 = { y: 2023, m0: 3 };
  const DELIVERY = { y: 2025, m0: 2 };

  const bonusPayoutFactor: Record<number, number> = { 2020: 0.6, 2021: 1, 2022: 0.9, 2023: 0.95, 2024: 0.75, 2025: 1.05, 2026: 1 };

  // =========================================================================================
  // The month loop
  // =========================================================================================
  // Money lent to friends and family (recorded through the money-lent flow). Declared before the
  // monthly loop so the running cash and the no-dip guard can see these flows.
  const RECEIVABLE_PLAN: DemoReceivable[] = [
    { person: "Sneha (cousin)", purpose: "Exam fee and travel", originalAmount: 15_000, givenAt: at(2025, 7, 11), expectedReturnAt: at(2025, 9, 11), status: "OUTSTANDING", paymentMethod: "UPI", notes: null, repayments: [{ amount: 15_000, returnedAt: at(2025, 9, 14), notes: "Returned in full" }] },
    { person: "Rohit (college friend)", purpose: "Bike repair and rent shortfall", originalAmount: 40_000, givenAt: at(2026, 0, 9), expectedReturnAt: at(2026, 3, 30), status: "OUTSTANDING", paymentMethod: "UPI", notes: "Promised to return in instalments", repayments: [{ amount: 20_000, returnedAt: at(2026, 2, 28), notes: null }, { amount: 10_000, returnedAt: at(2026, 5, 20), notes: null }] },
    { person: "Kunal (colleague)", purpose: "Short-term help, laptop repair", originalAmount: 25_000, givenAt: at(2026, 8, 12), expectedReturnAt: at(2026, 11, 15), status: "OUTSTANDING", paymentMethod: "UPI", notes: "Due after bonus month", repayments: [] },
  ];

  for (let idx = startIdx; idx <= endIdx; idx++) {
    const mStart = { cash: cashPaise, e: expenses.length, i: incomes.length, c: cashflows.length, m: emergencyEntries.length };
    const y = Math.floor(idx / 12);
    const m0 = idx % 12;
    const frac = monthFraction(y, m0);
    const stage = stageOf(y, m0);
    const infl = Math.pow(1.06, yearsBack(y, m0));
    const monthEnd = isCurrentMonth(y, m0) ? asOf : at(y, m0, daysIn(y, m0), 12, 0);

    // ---- salary & PF (1st of the month) ----------------------------------------------------
    const sal = salaryFor(y, m0);
    const salDate = at(y, m0, 1);
    const salaryKey = addIncome({
      source: "SALARY",
      label: `Salary - ${ym(y, m0)} (CTC Rs ${(ctcAt(y, m0) / 100_000).toFixed(1)} LPA)`,
      amount: sal.net,
      receivedAt: salDate,
      recurrence: "ONE_TIME",
      notes: "In-hand after PF, professional tax and TDS",
    });
    trackSeries("salary", salaryKey);
    if (salaryKey) {
      contribute("epf", sal.employeePf + sal.employerPf, salDate, ym(y, m0), "Employee + employer share, deducted at source", "EMPLOYER_CONTRIBUTION");
    }

    // Annual performance pay, every May.
    if (m0 === 4 && y > 2019) {
      const fyEnded = y - 1;
      const ctc = ctcAt(fyEnded, 8);
      const variable = roundTo(ctc * VARIABLE_PCT * (bonusPayoutFactor[y] ?? 1), 100);
      const fixed = ctc * FIXED_CASH_PCT;
      const tax = annualTax(fyEnded, fixed + variable) - annualTax(fyEnded, fixed);
      const key = addIncome({
        source: "BONUS",
        label: `Annual performance bonus - FY ${fyEnded}-${pad2((fyEnded + 1) % 100)}`,
        amount: Math.round(variable - tax),
        receivedAt: at(y, 4, 8),
        recurrence: "ONE_TIME",
        notes: "Net of TDS",
      });
      trackSeries("bonus", key);
    }
    // Joining bonus at the job switch.
    if (y === 2023 && m0 === 6) {
      addIncome({ source: "BONUS", label: "Joining bonus (new employer)", amount: 104_000, receivedAt: at(y, m0, 10), recurrence: "ONE_TIME", notes: "Rs 1.5 lakh gross, net of TDS" });
    }

    // Savings-account interest each quarter.
    if (m0 % 3 === 2) {
      const key = addIncome({
        source: "INTEREST",
        label: "Savings account interest",
        amount: roundTo(Math.max(300, cash() * 0.03 / 4), 10),
        receivedAt: at(y, m0, daysIn(y, m0)),
        recurrence: "ONE_TIME",
        notes: null,
      });
      trackSeries("interest", key);
    }
    // Dividends from the direct equity basket each August.
    if (m0 === 7 && inv.stocks.value > 20_000) {
      const key = addIncome({
        source: "DIVIDEND",
        label: "Dividends - blue-chip basket",
        amount: roundTo(inv.stocks.value * 0.012, 10),
        receivedAt: at(y, m0, 22),
        recurrence: "ONE_TIME",
        notes: null,
      });
      trackSeries("dividend", key);
    }
    // Wedding gifts and family contribution.
    if (y === WEDDING.y && m0 === WEDDING.m0) {
      addIncome({ source: "OTHER", label: "Wedding gifts (shagun)", amount: 125_000, receivedAt: at(y, m0, 14), recurrence: "ONE_TIME", notes: "Gifts received from relatives" });
      addIncome({ source: "OTHER", label: "Family contribution towards wedding", amount: 200_000, receivedAt: at(y, m0, 3), recurrence: "ONE_TIME", notes: "From parents" });
    }

    // Parents help with the flat's down payment.
    if (y === HOME_BUY.y && m0 === HOME_BUY.m0) {
      addIncome({ source: "OTHER", label: "Parents' contribution towards the flat", amount: 450_000, receivedAt: at(y, m0, 4), recurrence: "ONE_TIME", notes: "Family gift for the down payment" });
    }

    // ---- business month --------------------------------------------------------------------
    if (idx >= BUSINESS_START) {
      const revenue = bizMonth(y, m0);
      const invoices = revenue > 60_000 ? 3 : revenue > 30_000 ? 2 : 1;
      let left = revenue;
      for (let n = 0; n < invoices; n++) {
        const part = n === invoices - 1 ? left : roundTo(revenue / invoices * jitter(0.2), 500);
        left -= part;
        const date = at(y, m0, clampDay(y, m0, 5 + n * 8 + Math.floor(rand() * 4)));
        if (within(date) && part > 0) {
          businessTransactions.push({ key: `btx-${++businessKeySeq}`, type: "REVENUE", category: "Client projects", amount: part, occurredAt: date, description: `Invoice - ${["web build", "brand design", "landing page", "app UI", "maintenance retainer"][Math.floor(rand() * 5)]}`, isRecurring: false });
        }
      }
      const costs: [string, string, number][] = [
        ["Software & tools", "Design, hosting and project tools", revenue * 0.1],
        ["Freelancers", "Outsourced development / illustration", revenue * 0.18],
        ["Marketing", "Ads and portfolio promotion", revenue * 0.06],
        ["Internet & coworking", "Desk and connectivity", 1_800 * Math.pow(1.04, (idx - BUSINESS_START) / 12)],
      ];
      let costTotal = 0;
      costs.forEach(([cat, desc, amt], n) => {
        const a = roundTo(amt * jitter(0.1), 50);
        costTotal += a;
        const date = at(y, m0, clampDay(y, m0, 10 + n * 4));
        if (within(date) && a > 0) businessTransactions.push({ key: `btx-${++businessKeySeq}`, type: "EXPENSE", category: cat, amount: a, occurredAt: date, description: desc, isRecurring: cat === "Software & tools" || cat === "Internet & coworking" });
      });
      if (y === 2022 && m0 === 7) {
        costTotal += 62_000;
        businessTransactions.push({ key: `btx-${++businessKeySeq}`, type: "EXPENSE", category: "Equipment", amount: 62_000, occurredAt: at(y, m0, 18), description: "Studio laptop and display", isRecurring: false });
      }
      const profit = revenue - costTotal;
      const drawingDate = at(y, m0, clampDay(y, m0, 3));
      const drawing = profit > 0 ? floorTo(profit * 0.55, 500) : 0;
      if (drawing > 0 && within(drawingDate)) {
        const txKey = `btx-${++businessKeySeq}`;
        businessTransactions.push({ key: txKey, type: "OWNER_DRAWING", category: "Owner drawing", amount: drawing, occurredAt: drawingDate, description: "Monthly owner drawing", isRecurring: true });
        const key = addIncome({ source: "BUSINESS", label: "Owner drawing - Aarav Creative Studio", amount: drawing, receivedAt: drawingDate, recurrence: "ONE_TIME", notes: "Synced from the business ledger", businessTransactionKey: txKey });
        trackSeries("business", key);
      }
    }

    // ---- housing & loans -------------------------------------------------------------------
    const rent = rentFor(y, m0);
    if (rent) addExpense({ categoryName: "Rent", merchant: idx < monthIndex(2021, 3) ? "Landlord - shared flat" : "Landlord - Mr. Deshmukh", amount: rent, spentAt: at(y, m0, 3), paymentMethod: "BANK_TRANSFER", notes: "Monthly rent", isRecurring: true, flowType: "EXPENSE" });
    if (idx >= HOME_LOAN.start) {
      const r = HOME_LOAN.rate / 12 / 100;
      const date = at(y, m0, 5);
      if (within(date)) {
        const interest = balance.home * r;
        balance.home = Math.max(0, balance.home - (homeEmi - interest));
        const fy = financialYearOf(y, m0);
        interestPaidByFy[fy] = (interestPaidByFy[fy] ?? 0) + interest;
        addExpense({ categoryName: "EMI", merchant: "Metro Housing Finance - Home loan", amount: homeEmi, spentAt: date, paymentMethod: "BANK_TRANSFER", notes: "Home loan EMI (auto-debit)", isRecurring: true, flowType: "EXPENSE" });
      }
      addExpense({ categoryName: "Housing", merchant: "Society maintenance", amount: idx >= monthIndex(2026, 3) ? 2_650 : 2_500, spentAt: at(y, m0, 7), paymentMethod: "UPI", notes: "Monthly society charges", isRecurring: true, flowType: "EXPENSE" });
    }
    if (idx >= CAR_LOAN.start) {
      const r = CAR_LOAN.rate / 12 / 100;
      const date = at(y, m0, 5);
      if (within(date) && idx < CAR_LOAN.start + CAR_LOAN.months) {
        const interest = balance.car * r;
        balance.car = Math.max(0, balance.car - (carEmi - interest));
        addExpense({ categoryName: "EMI", merchant: "Metro Auto Finance - Car loan", amount: carEmi, spentAt: date, paymentMethod: "BANK_TRANSFER", notes: "Car loan EMI (auto-debit)", isRecurring: true, flowType: "EXPENSE" });
      }
    }

    // ---- fixed family lines ----------------------------------------------------------------
    if (idx >= monthIndex(2020, 0)) {
      const support = idx < monthIndex(2021, 0) ? 5_000 : idx < monthIndex(2022, 3) ? 6_000 : idx < monthIndex(2024, 3) ? 8_000 : idx < monthIndex(2026, 3) ? 9_000 : 10_000;
      addExpense({ categoryName: "Family Support", merchant: "Monthly support to parents", amount: support, spentAt: at(y, m0, 8), paymentMethod: "BANK_TRANSFER", notes: "Sent to parents in Nandurbar", isRecurring: true, flowType: "EXPENSE" });
    }
    if (idx >= monthIndex(2022, 11)) {
      addExpense({ categoryName: "Household Help", merchant: "Domestic help", amount: idx < monthIndex(2024, 3) ? 2_800 : idx < monthIndex(2026, 3) ? 3_200 : 3_500, spentAt: at(y, m0, 2), paymentMethod: "CASH", notes: "Cook and cleaning", isRecurring: true, flowType: "EXPENSE" });
    }
    if (idx >= monthIndex(2025, 2)) {
      const care = idx < monthIndex(2026, 3) ? 7_500 : 8_500;
      addExpense({ categoryName: "Childcare", merchant: "Little Steps daycare", amount: roundTo(care * 0.62, 50), spentAt: at(y, m0, 4), paymentMethod: "UPI", notes: "Daycare fee", isRecurring: true, flowType: "EXPENSE" });
      addExpense({ categoryName: "Childcare", merchant: "FirstCry baby supplies", amount: roundTo(care * 0.38 * jitter(0.12), 10), spentAt: at(y, m0, 16), paymentMethod: "CARD", notes: "Diapers, food and clothes", isRecurring: true, flowType: "EXPENSE" });
    }
    for (const s of subscriptions(y, m0)) {
      addExpense({ categoryName: "Subscriptions", merchant: s.merchant, amount: s.amount, spentAt: at(y, m0, s.day), paymentMethod: "CARD", notes: null, isRecurring: true, flowType: "EXPENSE" });
    }

    // ---- everyday living -------------------------------------------------------------------
    for (const line of LIVING) {
      const base = (line.target / infl) * line.stage[stage] * (line.seasonal ? line.seasonal(m0) : 1);
      let carFuelBoost = 1;
      if (line.cat === "Transport" && idx >= monthIndex(2023, 6)) carFuelBoost = 1.35;
      const total = roundTo(base * carFuelBoost * jitter(0.1), 10);
      const n = line.items[0] + Math.floor(rand() * (line.items[1] - line.items[0] + 1));
      let left = total;
      for (let k = 0; k < n; k++) {
        const share = k === n - 1 ? left : roundTo(total / n * jitter(0.35), 10);
        left -= share;
        const mi = (k + Math.floor(rand() * 2)) % line.merchants.length;
        addExpense({
          categoryName: line.cat,
          merchant: line.merchants[mi],
          amount: Math.max(10, share),
          spentAt: at(y, m0, clampDay(y, m0, 1 + Math.floor(((k + rand() * 0.8) * 27) / n))),
          paymentMethod: line.pay[mi],
          notes: null,
          isRecurring: line.cat === "Utilities",
          flowType: "EXPENSE",
        });
      }
    }

    // ---- yearly and one-off spends ---------------------------------------------------------
    const trip = TRIPS[ym(y, m0)];
    if (trip) addExpense({ categoryName: "Travel", merchant: trip[0], amount: trip[1], spentAt: at(y, m0, 12), paymentMethod: "CARD", notes: null, isRecurring: false, flowType: "EXPENSE" });
    const course = COURSES[ym(y, m0)];
    if (course) addExpense({ categoryName: "Education", merchant: course[0], amount: course[1], spentAt: at(y, m0, 9), paymentMethod: "CARD", notes: null, isRecurring: false, flowType: "EXPENSE" });
    const gadget = GADGETS[ym(y, m0)];
    if (gadget) addExpense({ categoryName: "Shopping", merchant: gadget[0], amount: gadget[1], spentAt: at(y, m0, 20), paymentMethod: "CARD", notes: "Bought on EMI-free card offer", isRecurring: false, flowType: "EXPENSE" });
    const diwali = DIWALI[y];
    if (diwali && diwali[0] === m0) {
      const festTotal = roundTo((28_000 / infl) * [0.45, 0.8, 1][stage], 100);
      addExpense({ categoryName: "Gifts & Festivals", merchant: "Diwali gifts, sweets and decorations", amount: festTotal, spentAt: at(y, m0, clampDay(y, m0, Math.max(1, diwali[1] - 5))), paymentMethod: "UPI", notes: "Family gifts and puja", isRecurring: false, flowType: "EXPENSE" });
    }
    if (m0 === 7) addExpense({ categoryName: "Gifts & Festivals", merchant: "Raksha Bandhan gifts", amount: roundTo(3_000 / infl, 100), spentAt: at(y, m0, 19), paymentMethod: "UPI", notes: null, isRecurring: false, flowType: "EXPENSE" });
    if (m0 === 11 && y >= 2023) addExpense({ categoryName: "Gifts & Festivals", merchant: "Wedding anniversary gift", amount: roundTo(6_000 / infl, 100), spentAt: at(y, m0, 9), paymentMethod: "CARD", notes: null, isRecurring: false, flowType: "EXPENSE" });
    if (y === WEDDING.y && m0 === WEDDING.m0) {
      addExpense({ categoryName: "Gifts & Festivals", merchant: "Wedding - venue, catering and rituals", amount: 360_000, spentAt: at(y, m0, 8), paymentMethod: "BANK_TRANSFER", notes: "Wedding expenses", isRecurring: false, flowType: "EXPENSE" });
      addExpense({ categoryName: "Shopping", merchant: "Wedding wardrobe and jewellery", amount: 50_000, spentAt: at(y, m0, 5), paymentMethod: "CARD", notes: null, isRecurring: false, flowType: "EXPENSE" });
    }
    if (y === HOSPITAL_1.y && m0 === HOSPITAL_1.m0) {
      addExpense({ categoryName: "Healthcare", merchant: "Orange City Hospital - father's admission", amount: 85_000, spentAt: at(y, m0, 12), paymentMethod: "CARD", notes: "Hospitalisation, paid from emergency reserve", isRecurring: false, flowType: "EXPENSE" });
      addEmergency({ type: "WITHDRAWAL", amount: 85_000, occurredAt: at(y, m0, 12, 5, 0), reason: "Father's hospitalisation", notes: "Used the emergency reserve as intended" });
    }
    if (y === DELIVERY.y && m0 === DELIVERY.m0) {
      addExpense({ categoryName: "Healthcare", merchant: "Care Women's Hospital - delivery balance", amount: 60_000, spentAt: at(y, m0, 8), paymentMethod: "CARD", notes: "Out-of-pocket after insurance", isRecurring: false, flowType: "EXPENSE" });
      addEmergency({ type: "WITHDRAWAL", amount: 60_000, occurredAt: at(y, m0, 8, 5, 0), reason: "Delivery hospital bill balance", notes: null });
    }
    const FURNISHING: Record<string, [string, number]> = {
      "2024-10": ["Modular kitchen and wardrobes", 70_000],
      "2024-11": ["Furniture - sofa, bed, dining", 55_000],
      "2024-12": ["Appliances - fridge and washing machine", 45_000],
      "2025-01": ["Curtains, lighting and fittings", 30_000],
      "2025-04": ["Air conditioner", 38_000],
    };
    const furnishing = FURNISHING[ym(y, m0)];
    if (furnishing) {
      addExpense({ categoryName: "Home & Furnishing", merchant: furnishing[0], amount: furnishing[1], spentAt: at(y, m0, 18), paymentMethod: "CARD", notes: "Setting up the new flat", isRecurring: false, flowType: "EXPENSE" });
    }
    if (m0 === 5 && idx >= monthIndex(2025, 5)) {
      addExpense({ categoryName: "Housing", merchant: "Municipal property tax", amount: 4_200, spentAt: at(y, m0, 15), paymentMethod: "UPI", notes: "Annual", isRecurring: true, flowType: "EXPENSE" });
    }
    if (m0 === 5 && idx >= monthIndex(2024, 5)) {
      addExpense({ categoryName: "Transport", merchant: "Car service and tyres", amount: roundTo(8_500 * Math.pow(1.05, y - 2024), 50), spentAt: at(y, m0, 24), paymentMethod: "CARD", notes: "Annual service", isRecurring: false, flowType: "EXPENSE" });
    }
    // Insurance premiums, on each policy's renewal date.
    for (const p of POLICY_PLANS) {
      if (y >= p.startY && m0 === p.month0) {
        addExpense({ categoryName: "Insurance", merchant: `${p.provider} - ${p.type.replace(/_/g, " ").toLowerCase()} premium`, amount: premiumFor(p, y), spentAt: at(y, m0, p.day), paymentMethod: "BANK_TRANSFER", notes: p.notes, isRecurring: true, flowType: "EXPENSE", policyKey: p.key, sourceReference: String(y) });
      }
    }

    // ---- other outflows (not spending): down payments, money lent -------------------------
    if (y === CAR_BUY.y && m0 === CAR_BUY.m0) {
      addExpense({ categoryName: "Asset Purchase", merchant: "Car showroom - down payment", amount: 200_000, spentAt: at(y, m0, 10), paymentMethod: "BANK_TRANSFER", notes: "Down payment on a Rs 8.5 lakh car; the rest is the car loan", isRecurring: false, flowType: "OTHER_OUTFLOW" });
      addExpense({ categoryName: "Asset Purchase", merchant: "Car registration, insurance and accessories", amount: 38_000, spentAt: at(y, m0, 12), paymentMethod: "CARD", notes: "On-road costs", isRecurring: false, flowType: "OTHER_OUTFLOW" });
    }
    if (y === HOME_BUY.y && m0 === HOME_BUY.m0) {
      addExpense({ categoryName: "Asset Purchase", merchant: "Builder - down payment (20%)", amount: FLAT_PRICE - HOME_LOAN.principal, spentAt: at(y, m0, 12), paymentMethod: "BANK_TRANSFER", notes: "2BHK flat, Manish Nagar. The Rs 35.2 lakh home loan is paid to the builder directly.", isRecurring: false, flowType: "OTHER_OUTFLOW" });
      addExpense({ categoryName: "Asset Purchase", merchant: "Stamp duty, registration and GST", amount: roundTo(FLAT_PRICE * 0.065, 1_000), spentAt: at(y, m0, 16), paymentMethod: "BANK_TRANSFER", notes: "Property registration costs", isRecurring: false, flowType: "OTHER_OUTFLOW" });
    }

    // ---- keep a cash floor: if the month's spending (a wedding, a down payment) would leave less
    // than Rs 40,000 (or the month would go below zero), the shortfall is raised by redeeming investments on day 2, before the spend.
    const bigMonth = (y === WEDDING.y && m0 === WEDDING.m0) || (y === CAR_BUY.y && m0 === CAR_BUY.m0) || (y === HOME_BUY.y && m0 === HOME_BUY.m0);
    const cashFloor = bigMonth ? 40_000 : 0;
    if (cash() < cashFloor) raiseCash(cashFloor - cash(), at(y, m0, 2, 5, 0), "Redeemed to fund a planned purchase");

    // ---- emergency reserve (day 6) ---------------------------------------------------------
    if (idx >= monthIndex(2020, 0) && frac >= 0.2) {
      const avgEssential = (() => {
        const lo = at(y, m0 - 6, 1).getTime();
        const hi = at(y, m0, 1).getTime();
        const rows = expenses.filter((e) => e.flowType === "EXPENSE" && e.spentAt.getTime() >= lo && e.spentAt.getTime() < hi && !["Gifts & Festivals", "Travel", "Shopping"].includes(e.categoryName));
        return rows.length ? rows.reduce((s, e) => s + e.amount, 0) / 6 : 0;
      })();
      const target = avgEssential * 6;
      const gap = target - emergencyBalance;
      if (gap > 1_000) {
        const amount = roundTo(Math.min(gap, Math.max(4_000, sal.net * 0.07)), 500);
        if (amount > 0 && cash() - amount > 25_000) addEmergency({ type: "ALLOCATE", amount, occurredAt: at(y, m0, 6, 5, 0), reason: null, notes: "Monthly top-up towards 6 months of expenses" });
      }
    }

    // ---- SIPs (day 5) ----------------------------------------------------------------------
    const sip = (key: string, amount: number, startIdxForSip: number) => {
      if (idx < startIdxForSip || amount <= 0) return;
      contribute(key, amount, at(y, m0, 5), ym(y, m0), "SIP");
    };
    const idxSip = idx < monthIndex(2021, 3) ? 3_000 : idx < monthIndex(2022, 3) ? 5_000 : idx < monthIndex(2023, 7) ? 7_500 : idx < monthIndex(2025, 3) ? 10_000 : 15_000;
    sip("idx", idxSip, monthIndex(2019, 10));
    sip("flexi", idx < monthIndex(2023, 3) ? 3_000 : idx < monthIndex(2025, 3) ? 6_000 : 10_000, monthIndex(2021, 5));
    sip("small", idx < monthIndex(2024, 3) ? 2_500 : idx < monthIndex(2026, 3) ? 5_000 : 7_500, monthIndex(2022, 5));
    sip("nps", 3_000, monthIndex(2022, 3));

    // ---- lump sums -------------------------------------------------------------------------
    if (m0 === 4 && y > 2019) {
      contribute("stocks", roundTo(Math.min(60_000, Math.max(20_000, cash() * 0.25)), 5_000), at(y, m0, 15), `${y}-LUMP`, "Invested part of the annual bonus");
      contribute("gold", 25_000, at(y, m0, 10), `${y}-AT`, "Akshaya Tritiya purchase");
    }
    if (y === 2025 && m0 === 4) contribute("fd", 100_000, at(y, m0, 12), "2025-FD", "3-year fixed deposit at 7.1%, opened with part of the bonus");
    if (m0 === 2) contribute("ppf", 50_000, at(y, m0, 15), `${y}-FY`, "Yearly PPF deposit");

    // ---- quarter-end sweep: idle cash above a sensible buffer goes into funds --------------
    if (m0 % 3 === 2 && idx > startIdx + 2) {
      const date = at(y, m0, 26);
      if (within(date)) {
        const buffer = Math.max(60_000, 2 * (sal.net * 0.55));
        const excess = cash() - buffer;
        if (excess >= 30_000) {
          const total = floorTo(excess * 0.8, 5_000);
          if (total > 0) {
            const toIdx = roundTo(total * 0.6, 1_000);
            contribute("idx", toIdx, date, `${ym(y, m0)}-TOPUP`, "Quarterly top-up from surplus cash");
            contribute("flexi", total - toIdx, date, `${ym(y, m0)}-TOPUP`, "Quarterly top-up from surplus cash");
          }
        }
      }
    }

    // ---- no-dip guard: replay this month day by day; if cash would ever fall below Rs 2,000,
    // raise the shortfall on day 2 by redeeming holdings (so the story never needs a negative balance).
    for (let attempt = 0; attempt < 4; attempt++) {
      const evs: { at: number; d: number }[] = [];
      for (const x of incomes.slice(mStart.i)) evs.push({ at: x.receivedAt.getTime(), d: Math.round(x.amount * 100) });
      for (const x of expenses.slice(mStart.e)) evs.push({ at: x.spentAt.getTime(), d: -Math.round(x.amount * 100) });
      for (const x of cashflows.slice(mStart.c)) {
        if (x.type === "CONTRIBUTION") evs.push({ at: x.occurredAt.getTime(), d: -Math.round(x.amount * 100) });
        if (x.type === "WITHDRAWAL") evs.push({ at: x.occurredAt.getTime(), d: Math.round(x.amount * 100) });
      }
      for (const r of RECEIVABLE_PLAN) {
        const inMonth = (t: Date) => t.getUTCFullYear() === y && t.getUTCMonth() === m0 && within(t);
        if (inMonth(r.givenAt)) evs.push({ at: r.givenAt.getTime(), d: -Math.round(r.originalAmount * 100) });
        for (const x of r.repayments) if (inMonth(x.returnedAt)) evs.push({ at: x.returnedAt.getTime(), d: Math.round(x.amount * 100) });
      }
      for (const x of emergencyEntries.slice(mStart.m)) evs.push({ at: x.occurredAt.getTime(), d: x.type === "ALLOCATE" ? -Math.round(x.amount * 100) : Math.round(x.amount * 100) });
      evs.sort((p, q) => p.at - q.at || q.d - p.d);
      let run = mStart.cash;
      let low = run;
      for (const ev of evs) {
        run += ev.d;
        if (run < low) low = run;
      }
      const shortfall = 200_000 - low; // paise
      if (shortfall <= 0) break;
      raiseCash(shortfall / 100, at(y, m0, 2, 5, 0), "Redeemed to keep the bank balance positive");
    }

    for (const r of RECEIVABLE_PLAN) {
      const inMonth = (t: Date) => t.getUTCFullYear() === y && t.getUTCMonth() === m0 && within(t);
      if (inMonth(r.givenAt)) bump(-r.originalAmount);
      for (const x of r.repayments) if (inMonth(x.returnedAt)) bump(x.amount);
    }

    // ---- returns, then month-end valuations ------------------------------------------------
    // (Contributions above were added at the start of the month, so they earn this month's return.)
    for (const d of defs) {
      const s = inv[d.key];
      if (!s.started) continue;
      const first = firstPurchase[d.key];
      if (first && first.getUTCFullYear() === y && first.getUTCMonth() === m0 && d.key !== "epf") {
        // bought during this month: earns half a month on average
        s.value = r2(s.value * (1 + (returnPct(y, m0, d.key) / 100) * 0.5 * frac));
      } else {
        s.value = r2(s.value * (1 + (returnPct(y, m0, d.key) / 100) * frac));
      }
      valuations.push({ investmentKey: d.key, value: s.value, valuedAt: monthEnd });
    }
  }

  // =========================================================================================
  // Assemble records that depend on the whole timeline
  // =========================================================================================

  // ---- recurring series: the latest row is the template, earlier rows point at it ----------
  const SERIES: Record<string, DemoRecurrence> = { salary: "MONTHLY", business: "MONTHLY", bonus: "YEARLY", interest: "QUARTERLY", dividend: "YEARLY" };
  for (const [name, recurrence] of Object.entries(SERIES)) {
    const rows = (seriesBySource[name] ?? []).sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    const template = rows[rows.length - 1];
    if (!template) continue;
    for (const row of rows) {
      row.recurrence = recurrence;
      row.templateKey = row === template ? null : template.key;
    }
  }
  incomes.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  expenses.sort((a, b) => a.spentAt.getTime() - b.spentAt.getTime());
  cashflows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  // ---- investments -------------------------------------------------------------------------
  const lastSip: Record<string, number> = {};
  for (const c of cashflows) if (c.periodKey && /^\d{4}-\d{2}$/.test(c.periodKey) && c.type === "CONTRIBUTION") lastSip[c.investmentKey] = c.amount;
  const sipKeys = new Set(["idx", "flexi", "small", "nps"]);
  const investments: DemoInvestment[] = defs.filter((d) => inv[d.key].started).map((d) => {
    const s = inv[d.key];
    const isSip = sipKeys.has(d.key);
    return {
      ...d,
      currentValue: r2(s.value),
      costBasis: r2(s.costBasis),
      purchaseDate: firstPurchase[d.key] ?? at(asOfY, asOfM, 1),
      sipActive: isSip,
      monthlyContribution: isSip ? lastSip[d.key] ?? null : null,
      contributionDay: isSip ? 5 : null,
      contributionStartDate: isSip ? firstPurchase[d.key] ?? null : null,
    };
  });

  // ---- loans & property --------------------------------------------------------------------
  const loans: DemoLoan[] = [
    { key: "home", type: "HOME", lender: "Metro Housing Finance", principal: HOME_LOAN.principal, outstandingPrincipal: Math.round(balance.home), interestRateAnnual: HOME_LOAN.rate, tenureMonths: HOME_LOAN.months, emiAmount: homeEmi, startDate: at(2024, 9, 5), notes: "Home loan for the 2BHK flat, 20 years" },
    { key: "car", type: "CAR", lender: "Metro Auto Finance", principal: CAR_LOAN.principal, outstandingPrincipal: Math.round(balance.car), interestRateAnnual: CAR_LOAN.rate, tenureMonths: CAR_LOAN.months, emiAmount: carEmi, startDate: at(2023, 6, 5), notes: "Car loan, 5 years" },
  ];
  const yearsOwned = Math.max(0, (endIdx - monthIndex(2024, 7)) / 12);
  const properties: DemoProperty[] = [
    {
      key: "flat",
      type: "APARTMENT",
      name: "2BHK flat, Manish Nagar",
      address: "Manish Nagar, Nagpur, Maharashtra",
      currentValue: roundTo(FLAT_PRICE * Math.pow(1.055, yearsOwned), 1_000),
      purchasePrice: FLAT_PRICE,
      purchaseDate: at(2024, 7, 12),
      annualMaintenanceCost: 30_000,
      annualPropertyTax: 4_200,
      loanKey: "home",
      policyKey: "home",
      notes: "Self-occupied. Possession Oct 2024.",
    },
  ];

  // ---- insurance policies ------------------------------------------------------------------
  const policies: DemoPolicy[] = POLICY_PLANS.filter((p) => monthIndex(p.startY, p.month0) <= endIdx).map((p) => {
    // The next renewal on or after today, and the premium that renewal will charge.
    let renewal = at(asOfY, p.month0, p.day);
    if (renewal.getTime() < asOf.getTime()) renewal = at(asOfY + 1, p.month0, p.day);
    return {
      key: p.key,
      type: p.type,
      provider: p.provider,
      policyNumber: policyNumbers[p.key],
      premiumAmount: premiumFor(p, renewal.getUTCFullYear()),
      premiumFrequency: "YEARLY" as const,
      coverageAmount: p.coverage,
      renewalDate: renewal,
      nomineeName: p.nominee,
      nomineeDependentName: p.nomineeDependent,
      notes: p.notes,
    };
  });

  // ---- goals -------------------------------------------------------------------------------
  const val = (k: string) => inv[k].value;
  const retirementValue = val("epf") + val("ppf") + val("nps") + val("idx");
  // The reserve target is 6 x the average monthly NEED spending of the last 3 full months: the same
  // definition the Emergency Fund page uses for coverage, so goal, target and coverage agree.
  const needNames = new Set(CATEGORIES.filter((c) => c.type === "NEED").map((c) => c.name));
  const needByMonth = new Map<string, number>();
  for (const e of expenses) {
    if (e.flowType !== "EXPENSE" || !needNames.has(e.categoryName)) continue;
    const k = ym(e.spentAt.getUTCFullYear(), e.spentAt.getUTCMonth());
    needByMonth.set(k, (needByMonth.get(k) ?? 0) + e.amount);
  }
  const lastFull = [1, 2, 3].map((n) => needByMonth.get(ym(...(((): [number, number] => { const i = monthIndex(asOfY, asOfM) - n; return [Math.floor(i / 12), i % 12]; })()))) ?? 0);
  const avgNeed = lastFull.reduce((x, y) => x + y, 0) / 3;
  const emergencyTarget = roundTo(Math.max(avgNeed * 6, emergencyBalance), 10_000);

  const goals: DemoGoal[] = [
    { key: "emergency", type: "EMERGENCY_FUND", name: "Emergency fund (6 months of essentials)", targetAmount: emergencyTarget, targetDate: at(asOfY + (asOfM > 6 ? 1 : 0), (asOfM + 5) % 12, 28), currentAmount: Math.round(emergencyBalance), monthlyContribution: 7_000, assumedAnnualReturnPercent: null },
    { key: "retirement", type: "RETIREMENT", name: "Retirement corpus at 60", targetAmount: 50_000_000, targetDate: at(2053, 5, 14), currentAmount: Math.round(retirementValue), monthlyContribution: 3_000 + 10_000 + Math.round(salaryFor(asOfY, asOfM).employeePf * 2), assumedAnnualReturnPercent: 11 },
    { key: "education", type: "CHILD_EDUCATION", name: "Ira's higher education", targetAmount: 4_000_000, targetDate: at(2043, 5, 30), currentAmount: Math.round(val("flexi")), monthlyContribution: 10_000, assumedAnnualReturnPercent: 12 },
    { key: "vacation", type: "VACATION", name: "Family holiday abroad", targetAmount: 350_000, targetDate: at(2028, 0, 15), currentAmount: 45_000, monthlyContribution: 8_000, assumedAnnualReturnPercent: null },
  ];

  // ---- lending, transfers ------------------------------------------------------------------
  const receivables: DemoReceivable[] = [];
  const addReceivable = (r: DemoReceivable) => {
    if (r.givenAt.getTime() <= asOf.getTime()) {
      const repayments = r.repayments.filter((x) => x.returnedAt.getTime() <= asOf.getTime());
      const repaid = repayments.reduce((s, x) => s + x.amount, 0);
      receivables.push({ ...r, repayments, status: repaid >= r.originalAmount ? "FULLY_RETURNED" : repaid > 0 ? "PARTIALLY_RETURNED" : "OUTSTANDING" });
    }
  };
  for (const r of RECEIVABLE_PLAN) addReceivable(r);

  const transfers: DemoTransfer[] = [];
  for (let idx = startIdx; idx <= endIdx; idx++) {
    const y = Math.floor(idx / 12);
    const m0 = idx % 12;
    if (m0 % 3 === 0 && idx >= monthIndex(2021, 0)) {
      const date = at(y, m0, 9);
      if (within(date)) transfers.push({ fromAccount: "Salary account", toAccount: "Savings account", amount: roundTo(25_000 + (idx - monthIndex(2021, 0)) * 500, 5_000), transferredAt: date, notes: "Quarterly move to the savings account (not income, not an expense)" });
    }
  }

  // ---- business ----------------------------------------------------------------------------
  const nextOn = (m0: number, day: number) => {
    const d = at(asOfY, m0, day);
    return d.getTime() > asOf.getTime() ? d : at(asOfY + 1, m0, day);
  };
  const nextMarch = (day: number) => nextOn(2, day);
  const nextJuly31 = nextOn(6, 31);
  const businessObligations: DemoBusinessObligation[] = [
    { title: "ITR-4 filing for the studio", dueDate: nextJuly31, amount: null, recurrence: "YEARLY", vendor: "Income tax portal", status: "PENDING", notes: "Presumptive taxation; last year's return was filed on time" },
    { title: "Domain and hosting renewal", dueDate: nextMarch(10), amount: 4_800, recurrence: "YEARLY", vendor: "Hostly", status: "PENDING", notes: null },
    { title: "Professional indemnity renewal", dueDate: nextMarch(25), amount: premiumFor(POLICY_PLANS[7], nextMarch(25).getUTCFullYear()), recurrence: "YEARLY", vendor: "Suraksha Life Insurance", status: "PENDING", notes: null },
    { title: "Coworking desk fee", dueDate: at(asOfY, asOfM, 10), amount: 1_800, recurrence: "MONTHLY", vendor: "Hub Nagpur", status: asOf.getUTCDate() >= 10 ? "PAID" : "PENDING", notes: null },
  ];

  // ---- tax deductions (new regime is the default; these feed the old-vs-new comparison) -----
  // Every figure is read back from what was actually recorded in that financial year.
  const taxDeductions: DemoTaxDeduction[] = [];
  const currentFyStart = fyStartYear(asOfY, asOfM);
  for (const s0 of [currentFyStart - 1, currentFyStart]) {
    const fy = `${s0}-${pad2((s0 + 1) % 100)}`;
    const lo = at(s0, 3, 1, 0, 0).getTime();
    const hi = at(s0 + 1, 3, 1, 0, 0).getTime();
    const inFy = (c: DemoCashflow, key: string) => c.investmentKey === key && c.occurredAt.getTime() >= lo && c.occurredAt.getTime() < hi;
    const employeePf = cashflows.filter((c) => inFy(c, "epf")).reduce((t, c) => t + c.amount, 0) / 2;
    const ppf = cashflows.filter((c) => inFy(c, "ppf")).reduce((t, c) => t + c.amount, 0);
    const nps = cashflows.filter((c) => inFy(c, "nps")).reduce((t, c) => t + c.amount, 0);
    const healthPremium = ["health", "parents"].reduce((t, k) => {
      const plan = POLICY_PLANS.find((p) => p.key === k)!;
      const year = plan.month0 >= 3 ? s0 : s0 + 1;
      return t + (year >= plan.startY && at(year, plan.month0, plan.day).getTime() <= asOf.getTime() ? premiumFor(plan, year) : 0);
    }, 0);
    if (employeePf > 0) taxDeductions.push({ section: "SECTION_80C", description: "Employee PF (deducted from salary)", amount: Math.round(employeePf), financialYear: fy });
    if (ppf > 0) taxDeductions.push({ section: "SECTION_80C", description: "Public Provident Fund deposit", amount: Math.round(ppf), financialYear: fy });
    if (healthPremium > 0) taxDeductions.push({ section: "SECTION_80D", description: "Health insurance - family floater and parents", amount: Math.round(healthPremium), financialYear: fy });
    if (nps > 0) taxDeductions.push({ section: "SECTION_80CCD_1B", description: "NPS Tier I voluntary contribution", amount: Math.round(Math.min(nps, 50_000)), financialYear: fy });
    if (interestPaidByFy[fy]) taxDeductions.push({ section: "HOME_LOAN_INTEREST", description: "Home loan interest paid (self-occupied)", amount: Math.round(interestPaidByFy[fy]), financialYear: fy });
  }

  const dependents: DemoDependent[] = [
    { name: "Priya Sharma", relation: "Spouse", dateOfBirth: new Date(Date.UTC(1995, 1, 20)) },
    { name: "Ira Sharma", relation: "Daughter", dateOfBirth: new Date(Date.UTC(2025, 2, 8)) },
    { name: "Suresh Sharma", relation: "Father", dateOfBirth: new Date(Date.UTC(1963, 10, 2)) },
    { name: "Meena Sharma", relation: "Mother", dateOfBirth: new Date(Date.UTC(1966, 6, 25)) },
  ].filter((d) => d.dateOfBirth.getTime() <= asOf.getTime());

  // ---- budgets: what he plans to spend in a month today -----------------------------------
  const budgets = [
    ["Groceries", 14_000], ["Dining Out", 6_000], ["Transport", 8_000], ["Utilities", 7_000], ["Shopping", 6_000],
    ["Entertainment", 3_000], ["Healthcare", 3_000], ["Personal Care", 3_000], ["Subscriptions", 3_500],
    ["Childcare", 9_000], ["Family Support", 12_000], ["EMI", homeEmi + carEmi],
  ].map(([categoryName, monthlyAmount]) => ({ categoryName: categoryName as string, monthlyAmount: monthlyAmount as number }));

  const emergencyPlan = { targetMonths: 6, monthlyContribution: 7_000, targetDate: goals[0].targetDate };

  const dataset: DemoDataset = {
    asOf,
    startMonth: ym(Math.floor(startIdx / 12), startIdx % 12),
    endMonth: ym(asOfY, asOfM),
    persona: { name: "Aarav Sharma", dateOfBirth: new Date(Date.UTC(1993, 5, 14)), city: "Nagpur" },
    household: { name: "Sharma Family" },
    dependents,
    categories: CATEGORIES,
    incomes,
    expenses,
    investments,
    cashflows,
    valuations,
    emergencyEntries,
    emergencyPlan,
    loans,
    properties,
    policies,
    business: { name: "Aarav Creative Studio", description: "Web, brand and app design for small businesses", entityType: "SOLE_PROPRIETORSHIP", startedAt: at(2022, 1, 1), ownershipPercent: 100 },
    businessTransactions,
    businessObligations,
    goals,
    receivables,
    transfers,
    taxDeductions,
    retirement: { targetRetirementAge: 60, desiredMonthlyIncomeToday: 90_000, inflationRatePercent: 6, expectedReturnPreRetirementPercent: 11, expectedReturnPostRetirementPercent: 7, lifeExpectancyAge: 85 },
    budgets,
    facts: { currentCtc: ctcAt(asOfY, asOfM), currentMonthlyNetSalary: salaryFor(asOfY, asOfM).net, months: MONTHS },
  };

  return dataset;
}
