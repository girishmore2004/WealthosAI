// import { formatINR, formatPercent } from "@/lib/format";
// import type { DashboardSummaryDTO } from "@wealthos/types";

// export function NetWorthCard({ summary }: { summary: DashboardSummaryDTO }) {
//   const rows = [
//     { label: "Net worth", value: summary.netWorth },
//     { label: "Cash balance", value: summary.cashBalance },
//     { label: "Investments", value: summary.investmentsValue },
//     { label: "Total debt", value: summary.totalDebt },
//     { label: "Income this month", value: summary.monthlyIncome },
//     { label: "Spent this month", value: summary.monthlyExpenses },
//   ];

//   return (
//     <div className="rounded-sm border border-line bg-surface p-5">
//       <p className="mb-3 text-xs uppercase tracking-wide text-ink-faint">This month, at a glance</p>
//       <dl>
//         {rows.map((row, i) => (
//           <div
//             key={row.label}
//             className={`flex items-center justify-between py-2 text-sm ${i !== rows.length - 1 ? "ledger-rule" : ""}`}
//           >
//             <dt className="text-ink-soft">{row.label}</dt>
//             <dd className="money text-ink">{formatINR(row.value)}</dd>
//           </div>
//         ))}
//       </dl>
//       <p className="mt-3 text-xs text-ink-faint">
//         Savings rate: <span className="money">{formatPercent(summary.savingsRate)}</span>
//       </p>
//     </div>
//   );
// }


import { formatINR, formatPercent } from "@/lib/format";
import type { DashboardSummaryDTO } from "@wealthos/types";

export function NetWorthCard({ summary }: { summary: DashboardSummaryDTO }) {
  const rows = [
    { label: "Net worth", value: summary.netWorth, emphasis: true },
    { label: "Cash balance", value: summary.cashBalance },
    { label: "Uncommitted cash", value: summary.uncommittedCash },
    { label: "Investments", value: summary.investmentsValue },
    { label: "Total debt", value: summary.totalDebt },
    { label: "Income this month", value: summary.monthlyIncome },
    { label: "Spent this month", value: summary.monthlyExpenses },
  ];

  return (
    <div className="panel p-5 sm:p-6">
      <p className="stat-label mb-3">This month, at a glance</p>
      <dl>
        {rows.map((row, i) => (
          <div
            key={row.label}
            className={`flex items-center justify-between py-2.5 text-sm ${i !== rows.length - 1 ? "ledger-rule" : ""}`}
          >
            <dt className={row.emphasis ? "font-medium text-ink" : "text-ink-soft"}>{row.label}</dt>
            <dd className={`money ${row.emphasis ? "text-base font-semibold text-ink" : "text-ink"}`}>
              {formatINR(row.value)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex items-center justify-between rounded-md bg-surface-muted px-3 py-2.5">
        <p className="text-xs text-ink-faint">Savings rate</p>
        <p className="money text-sm font-semibold text-gain">{formatPercent(summary.savingsRate)}</p>
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        Uncommitted cash is cash balance minus money already earmarked toward savings goals — an
        approximation, not a bank-verified figure.
        {summary.emergencyFundBasis === "CATEGORY_LEGACY" && (
          <>
            {" "}
            Your emergency-fund score is currently based on an expense logged under an
            &quot;Emergency Fund&quot; category — create a dedicated Emergency Fund goal for a more
            accurate figure.
          </>
        )}
        {summary.emergencyFundBasis === "NONE" && (
          <> Set up an Emergency Fund goal to have it reflected in your health score.</>
        )}
      </p>
    </div>
  );
}
