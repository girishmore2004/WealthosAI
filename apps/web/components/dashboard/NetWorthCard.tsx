import { formatINR, formatPercent } from "@/lib/format";
import type { DashboardSummaryDTO } from "@wealthos/types";

export function NetWorthCard({ summary }: { summary: DashboardSummaryDTO }) {
  const rows = [
    { label: "Net worth", value: summary.netWorth },
    { label: "Cash balance", value: summary.cashBalance },
    { label: "Investments", value: summary.investmentsValue },
    { label: "Total debt", value: summary.totalDebt },
    { label: "Income this month", value: summary.monthlyIncome },
    { label: "Spent this month", value: summary.monthlyExpenses },
  ];

  return (
    <div className="rounded-sm border border-line bg-surface p-5">
      <p className="mb-3 text-xs uppercase tracking-wide text-ink-faint">This month, at a glance</p>
      <dl>
        {rows.map((row, i) => (
          <div
            key={row.label}
            className={`flex items-center justify-between py-2 text-sm ${i !== rows.length - 1 ? "ledger-rule" : ""}`}
          >
            <dt className="text-ink-soft">{row.label}</dt>
            <dd className="money text-ink">{formatINR(row.value)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-ink-faint">
        Savings rate: <span className="money">{formatPercent(summary.savingsRate)}</span>
      </p>
    </div>
  );
}
