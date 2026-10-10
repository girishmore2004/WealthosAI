"use client";

import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MonthlyReportDetailDTO, ReportCategoryRowDTO, YearlyMonthsReportDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { useFinancialVersion } from "@/lib/financial-events";
import { formatDay, formatMonth } from "@/lib/dates";
import { formatINR, formatPercent } from "@/lib/format";
import { BasisTag } from "@/components/ui/BasisTag";

const monthInput = (d: Date = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const change = (p: number | null) => (p === null ? "—" : `${p > 0 ? "+" : ""}${formatPercent(p)}`);

function Line2({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="money text-ink">{value}</dd>
    </div>
  );
}

function CategoryTable({ rows, previousLabel }: { rows: ReportCategoryRowDTO[]; previousLabel: string }) {
  if (rows.length === 0) return <p className="text-sm text-ink-faint">No spending recorded in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Spending by category compared with {previousLabel}</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
            <th scope="col" className="py-2 pr-3 font-medium">Category</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Amount</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Share</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">{previousLabel}</th>
            <th scope="col" className="py-2 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.categoryId} className="border-t border-line">
              <td className="py-2 pr-3 text-ink">{r.category}</td>
              <td className="money py-2 pr-3 text-right text-ink">{formatINR(r.amount)}</td>
              <td className="py-2 pr-3 text-right text-ink-soft">{r.percentOfTotal === null ? "—" : formatPercent(r.percentOfTotal)}</td>
              <td className="money py-2 pr-3 text-right text-ink-soft">{formatINR(r.previousAmount)}</td>
              <td className="py-2 text-right text-ink-soft">{change(r.changePercent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Narrative({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="panel p-5">
      <h2 className="mb-2 font-display text-lg text-ink">In words</h2>
      <ul className="space-y-1.5 text-sm text-ink-soft">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function useReport<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useFinancialVersion();
  useEffect(() => {
    let live = true;
    setError(null);
    load()
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load the report."));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { data, error };
}

// January-to-today report for one month: the six flows, categories vs last month, daily spending,
// recurring vs one-time, biggest transactions, and the deterministic summary text.
export function MonthlyDetailReport() {
  const [month, setMonth] = useState(monthInput());
  const { data: r, error } = useReport<MonthlyReportDetailDTO>(() => api.reports.monthlyDetail(month), [month]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-ink-soft">
          Month{" "}
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="ml-1 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink" />
        </label>
        <BasisTag basis="ACTUAL" />
      </div>
      {error && <div role="alert" className="panel border-loss/30 bg-loss/5 p-4 text-sm text-loss">{error}</div>}
      {!r && !error && <p className="text-sm text-ink-faint">Loading report…</p>}
      {r && (
        <>
          <Narrative lines={r.narrative} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Income", r.income],
              ["Expenses", r.expenses],
              ["Investments", r.investments],
              ["Emergency fund", r.emergencyFund],
              ["Money lent", r.receivablesGiven],
              ["Repayments received", r.receivableRepayments],
              ["Other outflow", r.otherOutflow],
              ["Net cash flow", r.netCashFlow],
            ].map(([label, value]) => (
              <div key={label} className="panel p-4">
                <p className="stat-label">{label}</p>
                <p className="money mt-2 text-xl font-semibold text-ink">{formatINR(value)}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-faint">
            {formatINR(r.internalTransfers)} moved between your own accounts is not counted anywhere above. Savings rate{" "}
            {r.savingsRate === null ? "—" : formatPercent(r.savingsRate)} · investment rate {r.investmentRate === null ? "—" : formatPercent(r.investmentRate)} · expense rate{" "}
            {r.expenseRate === null ? "—" : formatPercent(r.expenseRate)}.
          </p>
          <div className="panel p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-lg text-ink">Net worth change</h2>
              <BasisTag basis="ESTIMATED" />
            </div>
            <p className="money mt-1 text-xl text-ink">{formatINR(r.netWorthChange.amount)}</p>
            <p className="mt-1 text-xs text-ink-faint">{r.netWorthChange.note}</p>
          </div>
          <div className="panel p-5">
            <h2 className="mb-3 font-display text-lg text-ink">Spending by category</h2>
            <CategoryTable rows={r.categories} previousLabel={formatMonth(r.comparison.from.slice(0, 7))} />
          </div>
          <div className="panel p-5">
            <h2 className="mb-3 font-display text-lg text-ink">Daily spending</h2>
            {r.dailySpending.some((d) => Number(d.total) > 0) ? (
              <div className="h-56" role="img" aria-label="Bar chart of daily spending">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={r.dailySpending.map((d) => ({ label: d.date.slice(8), total: Number(d.total) }))}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={56} />
                    <Tooltip formatter={(v: number) => formatINR(v)} />
                    <Bar dataKey="total" name="Spent" fill="#C77D1E" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-ink-faint">No spending recorded this month.</p>
            )}
            <dl className="mt-3 divide-y divide-line">
              <Line2 label="Average per day" value={formatINR(r.averagePerDay)} />
              {r.highestDay && <Line2 label="Highest spending day" value={`${formatDay(r.highestDay.date)} · ${formatINR(r.highestDay.total)}`} />}
              <Line2 label="Recurring" value={`${formatINR(r.recurringVsOneTime.recurring)}${r.recurringVsOneTime.recurringPercent === null ? "" : ` (${formatPercent(r.recurringVsOneTime.recurringPercent)})`}`} />
              <Line2 label="One-time" value={formatINR(r.recurringVsOneTime.oneTime)} />
            </dl>
          </div>
          <div className="panel p-5">
            <h2 className="mb-3 font-display text-lg text-ink">Largest transactions</h2>
            {r.largestTransactions.length === 0 ? (
              <p className="text-sm text-ink-faint">No expenses this month.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {r.largestTransactions.map((t) => (
                  <li key={t.id} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="text-ink-soft">
                      {t.merchant ?? t.categoryName} · {formatDay(t.spentAt)}
                    </span>
                    <span className="money text-ink">{formatINR(t.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// January to December for one calendar year, with trend charts and the year's category report.
export function YearByMonthReport() {
  const [year, setYear] = useState(new Date().getFullYear());
  const { data: y, error } = useReport<YearlyMonthsReportDTO>(() => api.reports.yearlyMonths(year), [year]);

  const chart = (y?.months ?? []).map((m) => ({
    label: formatMonth(m.month).slice(0, 3),
    Income: Number(m.income),
    Expenses: Number(m.expenses),
    Investments: Number(m.investments),
    Net: Number(m.netCashFlow),
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-1 rounded-md border border-line bg-surface p-1">
          <button type="button" aria-label="Previous year" onClick={() => setYear((v) => v - 1)} className="rounded px-2 py-1 text-sm text-ink-soft hover:text-ink">‹</button>
          <span className="min-w-[3.5rem] text-center text-sm font-medium text-ink" aria-live="polite">{year}</span>
          <button type="button" aria-label="Next year" onClick={() => setYear((v) => v + 1)} className="rounded px-2 py-1 text-sm text-ink-soft hover:text-ink">›</button>
        </div>
        <BasisTag basis="ACTUAL" />
      </div>
      {error && <div role="alert" className="panel border-loss/30 bg-loss/5 p-4 text-sm text-loss">{error}</div>}
      {!y && !error && <p className="text-sm text-ink-faint">Loading report…</p>}
      {y && (
        <>
          <Narrative lines={y.narrative} />
          <div className="panel p-5">
            <h2 className="mb-3 font-display text-lg text-ink">Month by month</h2>
            <div className="h-64" role="img" aria-label="Chart of income, expenses and investments for each month">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={60} />
                  <Tooltip formatter={(v: number) => formatINR(v)} />
                  <Legend />
                  <Line type="monotone" dataKey="Income" stroke="#2F7D5D" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Expenses" stroke="#B4412F" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Investments" stroke="#3A6EA5" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="panel overflow-x-auto p-5">
            <table className="w-full text-sm">
              <caption className="sr-only">Each month of {y.year}</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th scope="col" className="py-2 pr-3 font-medium">Month</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Income</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Expenses</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Invested</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Emergency</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Net</th>
                  <th scope="col" className="py-2 text-right font-medium">Savings rate</th>
                </tr>
              </thead>
              <tbody>
                {y.months.map((m) => (
                  <tr key={m.month} className="border-t border-line">
                    <th scope="row" className="py-2 pr-3 text-left font-normal text-ink">{formatMonth(m.month)}</th>
                    <td className="money py-2 pr-3 text-right">{formatINR(m.income)}</td>
                    <td className="money py-2 pr-3 text-right">{formatINR(m.expenses)}</td>
                    <td className="money py-2 pr-3 text-right">{formatINR(m.investments)}</td>
                    <td className="money py-2 pr-3 text-right">{formatINR(m.emergencyFund)}</td>
                    <td className="money py-2 pr-3 text-right">{formatINR(m.netCashFlow)}</td>
                    <td className="py-2 text-right text-ink-soft">{m.savingsRate === null ? "—" : formatPercent(m.savingsRate)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-line font-medium">
                  <th scope="row" className="py-2 pr-3 text-left">Total</th>
                  <td className="money py-2 pr-3 text-right">{formatINR(y.totals.income)}</td>
                  <td className="money py-2 pr-3 text-right">{formatINR(y.totals.expenses)}</td>
                  <td className="money py-2 pr-3 text-right">{formatINR(y.totals.investments)}</td>
                  <td className="money py-2 pr-3 text-right">{formatINR(y.totals.emergencyFund)}</td>
                  <td className="money py-2 pr-3 text-right">{formatINR(y.totals.netCashFlow)}</td>
                  <td className="py-2 text-right">{y.totals.savingsRate === null ? "—" : formatPercent(y.totals.savingsRate)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="panel p-5">
            <h2 className="mb-3 font-display text-lg text-ink">Category report</h2>
            <CategoryTable rows={y.categories} previousLabel={String(y.year - 1)} />
          </div>
        </>
      )}
    </div>
  );
}
