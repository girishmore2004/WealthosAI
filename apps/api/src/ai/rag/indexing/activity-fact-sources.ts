import { Prisma } from "@wealthos/db";
import { formatINR } from "../../../common/utils/currency.util";
import { FactSource } from "./financial-fact-sources";

// FINANCIAL_FACT sources about what the user DID (spending, income, trend) and portfolio-level overviews
// (insurance, loans, investments, goals). The base fact sources describe individual records; these add the
// aggregate answers people actually ask for: "what did I spend on food last month", "how much do I pay in
// premiums", "what are my total EMIs", "how is my spending trending".
//
// Pure functions of plain rows: no database access, no model. Every figure is computed here with Decimal
// from the user's own records, so it is exactly reproducible and safe to index. Month totals come from
// FinancialFactsService (the same numbers as the dashboard); the category / merchant / source splits come
// from the rows themselves.

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const day = (d: Date) => d.toISOString().slice(0, 10);
const lower = (s: string) => s.toLowerCase().replace(/_/g, " ");
const pct = (part: Prisma.Decimal, whole: Prisma.Decimal): string =>
  whole.lte(0) ? "n/a" : `${part.div(whole).times(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toFixed(1)}%`;

export interface MonthActivity {
  /** "YYYY-MM" */
  month: string;
  /** True for the month in progress (so "per day" uses the days elapsed, and the text says so). */
  inProgress: boolean;
  daysCounted: number;
  income: string;
  expenses: string;
  investmentContributions: string;
  savingsRate: string | null; // ratio, 0.25 = 25%
  expenseRows: Array<{ category: string; categoryType?: string; merchant: string | null; amount: string }>;
  incomeRows: Array<{ source: string; label: string; amount: string }>;
}

export interface ActivityFactInput {
  months: MonthActivity[]; // newest first
  policies: Array<{ provider: string; type: string; premiumAmount: string; premiumFrequency: string; coverageAmount: string; renewalDate: Date }>;
  loans: Array<{ lender: string; type: string; outstandingPrincipal: string; emiAmount: string; interestRateAnnual: string; tenureMonths: number; startDate: Date }>;
  investments: Array<{ name: string; type: string; currentValue: string }>;
  goals: Array<{ name: string; type: string; targetAmount: string; currentAmount: string; targetDate: Date; monthlyContribution: string }>;
}

const PERIODS_PER_YEAR: Record<string, number> = { WEEKLY: 52, BIWEEKLY: 26, MONTHLY: 12, QUARTERLY: 4, YEARLY: 1, ONE_TIME: 1 };

function groupSum<T>(rows: T[], keyOf: (r: T) => string, amountOf: (r: T) => string): Array<{ key: string; total: Prisma.Decimal; count: number }> {
  const map = new Map<string, { total: Prisma.Decimal; count: number }>();
  for (const r of rows) {
    const key = keyOf(r);
    const cur = map.get(key) ?? { total: D(0), count: 0 };
    cur.total = cur.total.plus(D(amountOf(r)));
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.total.comparedTo(a.total));
}

export function buildActivityFactSources(input: ActivityFactInput, today: Date): FactSource[] {
  const stamp = day(today);
  const out: FactSource[] = [];
  const add = (sourceId: string, factType: string, title: string, text: string, createdAt: Date = today, extra: Record<string, unknown> = {}) =>
    out.push({ sourceType: "FINANCIAL_FACT", sourceId, text, metadata: { title, factType, ...extra }, sourceCreatedAt: createdAt });

  // ---- Per month: spending, income -------------------------------------------------------------
  for (const m of input.months) {
    const state = m.inProgress ? `in progress, ${m.daysCounted} day${m.daysCounted === 1 ? "" : "s"} so far` : "complete month";
    const total = D(m.expenses);
    const monthStart = new Date(`${m.month}-01T00:00:00.000Z`);

    if (m.expenseRows.length > 0 || total.gt(0)) {
      const cats = groupSum(m.expenseRows, (r) => r.category, (r) => r.amount);
      const merchants = groupSum(m.expenseRows.filter((r) => r.merchant), (r) => r.merchant as string, (r) => r.amount).slice(0, 5);
      const perDay = m.daysCounted > 0 ? total.div(m.daysCounted) : D(0);
      const needs = D(0);
      void needs;
      add(
        `SPENDING:${m.month}`,
        "SPENDING",
        `Spending — ${m.month}`,
        `Spending in ${m.month} (${state}): total actual spending ${formatINR(m.expenses)}, about ${formatINR(perDay.toFixed(2))} per day. ` +
          (cats.length > 0
            ? `By category: ${cats.slice(0, 8).map((c) => `${c.key} ${formatINR(c.total.toFixed(2))} (${pct(c.total, total)})`).join(", ")}. `
            : "") +
          (merchants.length > 0 ? `Top merchants: ${merchants.map((c) => `${c.key} ${formatINR(c.total.toFixed(2))} over ${c.count} payment${c.count === 1 ? "" : "s"}`).join(", ")}. ` : "") +
          `Investments and emergency-fund transfers are not counted as spending.`,
        monthStart,
        { month: m.month },
      );
    }

    if (m.incomeRows.length > 0 || D(m.income).gt(0)) {
      const sources = groupSum(m.incomeRows, (r) => `${r.label} (${lower(r.source)})`, (r) => r.amount);
      add(
        `INCOME:${m.month}`,
        "INCOME",
        `Income — ${m.month}`,
        `Income in ${m.month} (${state}): total received ${formatINR(m.income)}. ` +
          (sources.length > 0 ? `Sources: ${sources.slice(0, 8).map((s) => `${s.key} ${formatINR(s.total.toFixed(2))}`).join(", ")}. ` : "") +
          `Invested ${formatINR(m.investmentContributions)}` +
          (m.savingsRate !== null ? `; savings rate ${D(m.savingsRate).times(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toFixed(1)}%.` : "."),
        monthStart,
        { month: m.month },
      );
    }
  }

  // ---- Month-by-month trend --------------------------------------------------------------------
  if (input.months.length > 1) {
    const rows = [...input.months].reverse(); // oldest first for reading
    add(
      `TREND:${stamp}`,
      "TREND",
      "Monthly trend",
      `Month-by-month trend (income / spending / invested): ` +
        rows
          .map((m) => `${m.month}${m.inProgress ? " (so far)" : ""}: income ${formatINR(m.income)}, spending ${formatINR(m.expenses)}, invested ${formatINR(m.investmentContributions)}`)
          .join("; ") +
        ".",
    );
  }

  // ---- Insurance overview ----------------------------------------------------------------------
  if (input.policies.length > 0) {
    let yearly = D(0);
    let cover = D(0);
    for (const p of input.policies) {
      yearly = yearly.plus(D(p.premiumAmount).times(PERIODS_PER_YEAR[p.premiumFrequency] ?? 1));
      cover = cover.plus(D(p.coverageAmount));
    }
    const next = [...input.policies].sort((a, b) => a.renewalDate.getTime() - b.renewalDate.getTime()).find((p) => p.renewalDate.getTime() >= today.getTime());
    add(
      `INSURANCE:overview`,
      "INSURANCE_OVERVIEW",
      "Insurance overview",
      `Insurance overview: ${input.policies.length} polic${input.policies.length === 1 ? "y" : "ies"}. Total premium paid per year ${formatINR(yearly.toFixed(2))} (about ${formatINR(yearly.div(12).toFixed(2))} per month). ` +
        `Total life and health cover ${formatINR(cover.toFixed(2))}. ` +
        input.policies.map((p) => `${p.provider} ${lower(p.type)}: premium ${formatINR(p.premiumAmount)} ${lower(p.premiumFrequency)}, cover ${formatINR(p.coverageAmount)}, renews ${day(p.renewalDate)}`).join("; ") +
        "." +
        (next ? ` Next renewal: ${next.provider} ${lower(next.type)} on ${day(next.renewalDate)}.` : ""),
    );
  }

  // ---- Loan overview ---------------------------------------------------------------------------
  if (input.loans.length > 0) {
    const out_ = input.loans.reduce((s, l) => s.plus(D(l.outstandingPrincipal)), D(0));
    const emi = input.loans.reduce((s, l) => s.plus(D(l.emiAmount)), D(0));
    add(
      `LOAN:overview`,
      "LOAN_OVERVIEW",
      "Loan overview",
      `Loan overview: ${input.loans.length} loan${input.loans.length === 1 ? "" : "s"}, total outstanding ${formatINR(out_.toFixed(2))}, total EMI ${formatINR(emi.toFixed(2))} per month. ` +
        input.loans
          .map((l) => `${l.lender} ${lower(l.type)} loan: outstanding ${formatINR(l.outstandingPrincipal)}, EMI ${formatINR(l.emiAmount)} per month at ${D(l.interestRateAnnual).toFixed(2)}%, ${l.tenureMonths} month tenure from ${day(l.startDate)}`)
          .join("; ") +
        ".",
    );
  }

  // ---- Investment allocation -------------------------------------------------------------------
  if (input.investments.length > 0) {
    const total = input.investments.reduce((s, i) => s.plus(D(i.currentValue)), D(0));
    const byType = groupSum(input.investments, (i) => lower(i.type), (i) => i.currentValue);
    add(
      `INVESTMENT:overview`,
      "INVESTMENT_OVERVIEW",
      "Investment allocation",
      `Investment portfolio: total current value ${formatINR(total.toFixed(2))} across ${input.investments.length} holding${input.investments.length === 1 ? "" : "s"}. ` +
        `Allocation by type: ${byType.map((t) => `${t.key} ${formatINR(t.total.toFixed(2))} (${pct(t.total, total)})`).join(", ")}.`,
    );
  }

  // ---- Goals -----------------------------------------------------------------------------------
  if (input.goals.length > 0) {
    add(
      `GOALS:overview`,
      "GOALS",
      "Goals",
      `Goals: ` +
        input.goals
          .map((g) => {
            const target = D(g.targetAmount);
            return `${g.name} (${lower(g.type)}): saved ${formatINR(g.currentAmount)} of ${formatINR(g.targetAmount)} (${pct(D(g.currentAmount), target)}), target date ${day(g.targetDate)}, contributing ${formatINR(g.monthlyContribution)} per month`;
          })
          .join("; ") +
        ".",
    );
  }

  return out;
}
