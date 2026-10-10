import { Prisma } from "@wealthos/db";

// Deterministic narrative for the dashboard and the reports. Every sentence is assembled from numbers
// the backend already calculated - there is no model call, no estimation and no rounding of its own
// beyond display formatting. If a number is missing the sentence is simply left out (or says so),
// it is never guessed.

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type MoneyLike = string | number | Prisma.Decimal | null | undefined;

const dec = (v: MoneyLike): Prisma.Decimal => {
  if (v === null || v === undefined || v === "") return new Prisma.Decimal(0);
  return new Prisma.Decimal(v);
};

/** "YYYY-MM" -> "October". Anything else is returned unchanged. */
export function monthName(month: string): string {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.exec(month);
  return m ? MONTH_NAMES[Number(m[1]) - 1] : month;
}

/** Indian digit grouping, whole rupees when there are no paise: 1542000 -> "₹15,42,000". */
export function formatRupees(value: MoneyLike): string {
  const d = dec(value);
  const abs = d.abs();
  const fixed = abs.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const [whole, frac] = fixed.toFixed(2).split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  const body = frac === "00" ? grouped : `${grouped}.${frac}`;
  return `${d.isNegative() && !fixed.isZero() ? "-" : ""}₹${body}`;
}

/** 23.74 -> "23.7%". */
export function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

const isPositive = (v: MoneyLike) => dec(v).greaterThan(0);

export interface MonthlyNarrativeInput {
  month: string;
  income: MoneyLike;
  expenses: MoneyLike;
  investments: MoneyLike;
  emergencyFund: MoneyLike;
  receivablesGiven: MoneyLike;
  receivableRepayments: MoneyLike;
  otherOutflow: MoneyLike;
  internalTransfers: MoneyLike;
  netCashFlow: MoneyLike;
  // Percent (1 dp), null when no income was recorded.
  expenseRate: number | null;
  investmentRate: number | null;
  savingsRate: number | null;
  topCategory?: { name: string; amount: MoneyLike; percentOfTotal: number | null } | null;
  // Spending change against the comparison window; changePercent is null with nothing to compare.
  comparison?: { label: string; changePercent: number | null } | null;
}

/** The monthly story, one sentence per fact, most important first. */
export function monthlyNarrative(i: MonthlyNarrativeInput): string[] {
  const name = monthName(i.month);
  const out: string[] = [];

  if (isPositive(i.income) && i.expenseRate !== null) {
    out.push(
      `Your ${name} expenses were ${formatRupees(i.expenses)}, representing ${formatPercent(i.expenseRate)} of your ${formatRupees(i.income)} income.`,
    );
  } else if (isPositive(i.income)) {
    out.push(`Your ${name} expenses were ${formatRupees(i.expenses)} against ${formatRupees(i.income)} of income.`);
  } else {
    out.push(`Your ${name} expenses were ${formatRupees(i.expenses)}. No income was recorded for ${name}, so no percentage of income is shown.`);
  }

  if (isPositive(i.investments)) {
    out.push(
      i.investmentRate !== null
        ? `You invested ${formatRupees(i.investments)} in ${name}, which is ${formatPercent(i.investmentRate)} of your income. Investments are not counted as expenses.`
        : `You invested ${formatRupees(i.investments)} in ${name}. Investments are not counted as expenses.`,
    );
  }
  if (isPositive(i.emergencyFund)) {
    out.push(`You added ${formatRupees(i.emergencyFund)} to your emergency fund. It is a reserve, not an expense.`);
  }
  if (isPositive(i.receivablesGiven)) {
    out.push(
      `You lent ${formatRupees(i.receivablesGiven)} to others. It is not an expense: it stays an asset until it is repaid.`,
    );
  }
  if (isPositive(i.receivableRepayments)) {
    out.push(`You received ${formatRupees(i.receivableRepayments)} back from money you had lent. It is not income.`);
  }
  if (isPositive(i.otherOutflow)) {
    out.push(`Other outflows that are not everyday spending came to ${formatRupees(i.otherOutflow)}.`);
  }
  if (isPositive(i.internalTransfers)) {
    out.push(
      `${formatRupees(i.internalTransfers)} moved between your own accounts. It is not income and not an expense.`,
    );
  }

  const net = dec(i.netCashFlow);
  out.push(
    net.isZero()
      ? `Your net cash flow for ${name} was ${formatRupees(0)}.`
      : net.isNegative()
        ? `Your net cash flow for ${name} was ${formatRupees(net)}, meaning more money went out than came in.`
        : `Your net cash flow for ${name} was ${formatRupees(net)}, meaning more money came in than went out.`,
  );

  if (i.savingsRate !== null) {
    out.push(
      i.savingsRate < 0
        ? `Your savings rate was ${formatPercent(i.savingsRate)} because expenses were higher than income.`
        : `Your savings rate was ${formatPercent(i.savingsRate)} (income minus expenses, as a share of income).`,
    );
  }

  if (i.topCategory && isPositive(i.topCategory.amount)) {
    out.push(
      i.topCategory.percentOfTotal !== null
        ? `${i.topCategory.name} was your biggest spending category at ${formatRupees(i.topCategory.amount)}, ${formatPercent(i.topCategory.percentOfTotal)} of your expenses.`
        : `${i.topCategory.name} was your biggest spending category at ${formatRupees(i.topCategory.amount)}.`,
    );
  }

  if (i.comparison && i.comparison.changePercent !== null) {
    const p = i.comparison.changePercent;
    out.push(
      p === 0
        ? `Spending was unchanged compared with ${i.comparison.label}.`
        : `Spending was ${formatPercent(Math.abs(p))} ${p > 0 ? "higher" : "lower"} than ${i.comparison.label}.`,
    );
  }
  return out;
}

export interface YearlyNarrativeInput {
  year: number;
  income: MoneyLike;
  expenses: MoneyLike;
  investments: MoneyLike;
  netCashFlow: MoneyLike;
  savingsRate: number | null;
  highestExpenseMonth: { month: string; total: MoneyLike } | null;
  lowestExpenseMonth: { month: string; total: MoneyLike } | null;
  monthsWithData: number;
  comparison?: { changePercent: number | null } | null;
  topCategory?: { name: string; amount: MoneyLike } | null;
}

export function yearlyNarrative(i: YearlyNarrativeInput): string[] {
  const out: string[] = [];
  if (i.monthsWithData === 0) {
    return [`No income or spending has been recorded for ${i.year} yet.`];
  }
  out.push(
    `In ${i.year} you recorded ${formatRupees(i.income)} of income and ${formatRupees(i.expenses)} of expenses across ${i.monthsWithData} month${i.monthsWithData === 1 ? "" : "s"} with activity.`,
  );
  if (isPositive(i.investments)) out.push(`You invested ${formatRupees(i.investments)} during ${i.year}. Investments are not counted as expenses.`);
  if (i.savingsRate !== null) out.push(`Your savings rate for ${i.year} was ${formatPercent(i.savingsRate)}.`);
  const net = dec(i.netCashFlow);
  out.push(`Your net cash flow for ${i.year} was ${formatRupees(net)}.`);
  if (i.highestExpenseMonth && isPositive(i.highestExpenseMonth.total)) {
    out.push(`${monthName(i.highestExpenseMonth.month)} was your highest-spending month at ${formatRupees(i.highestExpenseMonth.total)}.`);
  }
  if (
    i.lowestExpenseMonth &&
    i.highestExpenseMonth &&
    i.lowestExpenseMonth.month !== i.highestExpenseMonth.month
  ) {
    out.push(`${monthName(i.lowestExpenseMonth.month)} was your lowest-spending month at ${formatRupees(i.lowestExpenseMonth.total)}.`);
  }
  if (i.topCategory && isPositive(i.topCategory.amount)) {
    out.push(`${i.topCategory.name} was your biggest spending category at ${formatRupees(i.topCategory.amount)}.`);
  }
  if (i.comparison && i.comparison.changePercent !== null) {
    const p = i.comparison.changePercent;
    if (p !== 0) out.push(`Spending was ${formatPercent(Math.abs(p))} ${p > 0 ? "higher" : "lower"} than ${i.year - 1}.`);
  }
  return out;
}
