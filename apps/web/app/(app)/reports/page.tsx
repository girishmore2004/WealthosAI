// "use client";

// import { useEffect, useState } from "react";
// import type { MonthlyReportDTO, YearlyReportDTO } from "@wealthos/types";
// import { api, ApiError } from "@/lib/api-client";
// import { Card } from "@/components/ui/Card";
// import { formatINR, formatPercent } from "@/lib/format";

// export default function ReportsPage() {
//   const [view, setView] = useState<"monthly" | "yearly">("monthly");
//   const [monthly, setMonthly] = useState<MonthlyReportDTO | null>(null);
//   const [yearly, setYearly] = useState<YearlyReportDTO | null>(null);
//   const [error, setError] = useState<string | null>(null);

//   useEffect(() => {
//     setError(null);
//     if (view === "monthly") {
//       api.reports.monthly().then(setMonthly).catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the report."));
//     } else {
//       api.reports.yearly().then(setYearly).catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the report."));
//     }
//   }, [view]);

//   return (
//     <div className="space-y-6">
//       <div className="flex items-center justify-between">
//         <div>
//           <h1 className="font-display text-2xl text-ink">Reports</h1>
//           <p className="text-sm text-ink-soft">Monthly and yearly summaries, built from your existing data.</p>
//         </div>
//         <div className="flex gap-1 rounded-sm border border-line p-0.5">
//           {(["monthly", "yearly"] as const).map((v) => (
//             <button
//               key={v}
//               onClick={() => setView(v)}
//               className={`rounded-sm px-3 py-1.5 text-sm capitalize ${view === v ? "bg-marigold-50 text-marigold-600" : "text-ink-soft"}`}
//             >
//               {v}
//             </button>
//           ))}
//         </div>
//       </div>

//       {error && <p className="text-sm text-loss">{error}</p>}

//       {view === "monthly" && monthly && (
//         <>
//           <div className="grid gap-4 sm:grid-cols-3">
//             <Card>
//               <p className="text-xs uppercase tracking-wide text-ink-faint">Income ({monthly.month})</p>
//               <p className="money mt-1 text-xl text-gain">{formatINR(monthly.income)}</p>
//             </Card>
//             <Card>
//               <p className="text-xs uppercase tracking-wide text-ink-faint">Expenses</p>
//               <p className="money mt-1 text-xl text-loss">{formatINR(monthly.expenses)}</p>
//             </Card>
//             <Card>
//               <p className="text-xs uppercase tracking-wide text-ink-faint">Net cashflow</p>
//               <p className="money mt-1 text-xl text-ink">{formatINR(monthly.netCashflow)}</p>
//               <p className="mt-1 text-xs text-ink-faint">Savings rate: {formatPercent(monthly.savingsRate)}</p>
//             </Card>
//           </div>

//           <Card title="Expenses by category">
//             {monthly.expensesByCategory.length === 0 ? (
//               <p className="text-sm text-ink-faint">No expenses logged this month yet.</p>
//             ) : (
//               <ul>
//                 {monthly.expensesByCategory.map((row, i) => (
//                   <li key={row.category} className={`flex items-center justify-between py-2 text-sm ${i !== monthly.expensesByCategory.length - 1 ? "ledger-rule" : ""}`}>
//                     <span className="text-ink-soft">{row.category}</span>
//                     <span className="flex items-center gap-3">
//                       <span className="money text-ink">{formatINR(row.amount)}</span>
//                       <span className="text-xs text-ink-faint">{formatPercent(row.percentOfTotal)}</span>
//                     </span>
//                   </li>
//                 ))}
//               </ul>
//             )}
//           </Card>

//           {/* Uses the loaded report's own `month`, not a locally-recomputed "current
//               month" — guarantees the download always matches what's on screen, even
//               right at a month boundary. */}
//           <a href={api.reports.monthlyCsvUrl(monthly.month)} className="inline-block text-sm text-marigold-600 hover:underline">
//             Download this report as CSV
//           </a>
//         </>
//       )}

//       {view === "yearly" && yearly && (
//         <>
//           <p className="text-sm text-ink-soft">Financial year {yearly.financialYear}</p>
//           <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
//             <Card>
//               <p className="text-xs uppercase tracking-wide text-ink-faint">Total income</p>
//               <p className="money mt-1 text-lg text-gain">{formatINR(yearly.totalIncome)}</p>
//             </Card>
//             <Card>
//               <p className="text-xs uppercase tracking-wide text-ink-faint">Total expenses</p>
//               <p className="money mt-1 text-lg text-loss">{formatINR(yearly.totalExpenses)}</p>
//             </Card>
//             <Card>
//               <p className="text-xs uppercase tracking-wide text-ink-faint">Net savings</p>
//               <p className="money mt-1 text-lg text-ink">{formatINR(yearly.netSavings)}</p>
//             </Card>
//             <Card>
//               <p className="text-xs uppercase tracking-wide text-ink-faint">Investments value</p>
//               <p className="money mt-1 text-lg text-ink">{formatINR(yearly.investmentsCurrentValue)}</p>
//             </Card>
//             <Card>
//               <p className="text-xs uppercase tracking-wide text-ink-faint">Debt outstanding</p>
//               <p className="money mt-1 text-lg text-ink">{formatINR(yearly.totalDebtOutstanding)}</p>
//             </Card>
//             {yearly.businessProfit !== null && (
//               <Card>
//                 <p className="text-xs uppercase tracking-wide text-ink-faint">Business profit</p>
//                 <p className="money mt-1 text-lg text-ink">{formatINR(yearly.businessProfit)}</p>
//               </Card>
//             )}
//           </div>

//           <Card title="Expenses by category (full year)">
//             <ul>
//               {yearly.expensesByCategory.map((row, i) => (
//                 <li key={row.category} className={`flex items-center justify-between py-2 text-sm ${i !== yearly.expensesByCategory.length - 1 ? "ledger-rule" : ""}`}>
//                   <span className="text-ink-soft">{row.category}</span>
//                   <span className="flex items-center gap-3">
//                     <span className="money text-ink">{formatINR(row.amount)}</span>
//                     <span className="text-xs text-ink-faint">{formatPercent(row.percentOfTotal)}</span>
//                   </span>
//                 </li>
//               ))}
//             </ul>
//           </Card>

//           {/* Previously missing entirely — yearly data could be viewed but not
//               downloaded. */}
//           <a href={api.reports.yearlyCsvUrl(yearly.financialYear)} className="inline-block text-sm text-marigold-600 hover:underline">
//             Download this report as CSV
//           </a>
//         </>
//       )}

//       {((view === "monthly" && !monthly) || (view === "yearly" && !yearly)) && !error && (
//         <p className="text-sm text-ink-faint">Loading report…</p>
//       )}
//     </div>
//   );
// }





"use client";

import { useEffect, useState } from "react";
import type { MonthlyReportDTO, YearlyReportDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { formatINR, formatPercent } from "@/lib/format";

export default function ReportsPage() {
  const [view, setView] = useState<"monthly" | "yearly">("monthly");
  const [monthly, setMonthly] = useState<MonthlyReportDTO | null>(null);
  const [yearly, setYearly] = useState<YearlyReportDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (view === "monthly") {
      api.reports.monthly().then(setMonthly).catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the report."));
    } else {
      api.reports.yearly().then(setYearly).catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the report."));
    }
  }, [view]);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl text-ink sm:text-3xl">Reports</h1>
          <p className="text-sm text-ink-soft">Monthly and yearly summaries, built from your existing data.</p>
        </div>
        <div className="flex gap-1 rounded-md border border-line bg-surface p-1 shadow-card">
          {(["monthly", "yearly"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-sm capitalize transition-colors ${view === v ? "bg-marigold-50 font-medium text-marigold-600" : "text-ink-soft hover:text-ink"}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="panel border-loss/30 bg-loss/5 p-4 text-sm text-loss">{error}</div>
      )}

      {view === "monthly" && monthly && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card hover>
              <p className="stat-label">Income ({monthly.month})</p>
              <p className="money mt-1.5 text-2xl font-semibold text-gain">{formatINR(monthly.income)}</p>
            </Card>
            <Card hover>
              <p className="stat-label">Expenses</p>
              <p className="money mt-1.5 text-2xl font-semibold text-loss">{formatINR(monthly.expenses)}</p>
            </Card>
            <Card hover>
              <p className="stat-label">Net cashflow</p>
              <p className="money mt-1.5 text-2xl font-semibold text-ink">{formatINR(monthly.netCashflow)}</p>
              <p className="mt-1 text-xs text-ink-faint">Savings rate: {formatPercent(monthly.savingsRate)}</p>
            </Card>
          </div>

          <Card title="Expenses by category">
            {monthly.expensesByCategory.length === 0 ? (
              <p className="text-sm text-ink-faint">No expenses logged this month yet.</p>
            ) : (
              <ul>
                {monthly.expensesByCategory.map((row, i) => (
                  <li key={row.category} className={`flex items-center justify-between py-2 text-sm ${i !== monthly.expensesByCategory.length - 1 ? "ledger-rule" : ""}`}>
                    <span className="text-ink-soft">{row.category}</span>
                    <span className="flex items-center gap-3">
                      <span className="money text-ink">{formatINR(row.amount)}</span>
                      <span className="text-xs text-ink-faint">{formatPercent(row.percentOfTotal)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Uses the loaded report's own `month`, not a locally-recomputed "current
              month" — guarantees the download always matches what's on screen, even
              right at a month boundary. */}
          <a href={api.reports.monthlyCsvUrl(monthly.month)} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-marigold-500 hover:text-marigold-600">
            Download this report as CSV
          </a>
        </>
      )}

      {view === "yearly" && yearly && (
        <>
          <p className="text-sm text-ink-soft">Financial year {yearly.financialYear}</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card hover>
              <p className="stat-label">Total income</p>
              <p className="money mt-1.5 text-xl font-semibold text-gain">{formatINR(yearly.totalIncome)}</p>
            </Card>
            <Card hover>
              <p className="stat-label">Total expenses</p>
              <p className="money mt-1.5 text-xl font-semibold text-loss">{formatINR(yearly.totalExpenses)}</p>
            </Card>
            <Card hover>
              <p className="stat-label">Net savings</p>
              <p className="money mt-1.5 text-xl font-semibold text-ink">{formatINR(yearly.netSavings)}</p>
            </Card>
            <Card hover>
              <p className="stat-label">Investments value</p>
              <p className="money mt-1.5 text-xl font-semibold text-ink">{formatINR(yearly.investmentsCurrentValue)}</p>
            </Card>
            <Card hover>
              <p className="stat-label">Debt outstanding</p>
              <p className="money mt-1.5 text-xl font-semibold text-ink">{formatINR(yearly.totalDebtOutstanding)}</p>
            </Card>
            {yearly.businessProfit !== null && (
              <Card hover>
                <p className="stat-label">Business profit</p>
                <p className="money mt-1.5 text-xl font-semibold text-ink">{formatINR(yearly.businessProfit)}</p>
              </Card>
            )}
          </div>

          <Card title="Expenses by category (full year)">
            <ul>
              {yearly.expensesByCategory.map((row, i) => (
                <li key={row.category} className={`flex items-center justify-between py-2 text-sm ${i !== yearly.expensesByCategory.length - 1 ? "ledger-rule" : ""}`}>
                  <span className="text-ink-soft">{row.category}</span>
                  <span className="flex items-center gap-3">
                    <span className="money text-ink">{formatINR(row.amount)}</span>
                    <span className="text-xs text-ink-faint">{formatPercent(row.percentOfTotal)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          {/* Previously missing entirely — yearly data could be viewed but not
              downloaded. */}
          <a href={api.reports.yearlyCsvUrl(yearly.financialYear)} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-marigold-500 hover:text-marigold-600">
            Download this report as CSV
          </a>
        </>
      )}

      {((view === "monthly" && !monthly) || (view === "yearly" && !yearly)) && !error && (
        <p className="text-sm text-ink-faint">Loading report…</p>
      )}
    </div>
  );
}
