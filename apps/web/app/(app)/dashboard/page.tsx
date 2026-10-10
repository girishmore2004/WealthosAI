// "use client";

// import { useEffect, useState } from "react";
// import type { DashboardSummaryDTO } from "@wealthos/types";
// import { api, ApiError } from "@/lib/api-client";
// import { HealthScoreCard } from "@/components/dashboard/HealthScoreCard";
// import { NetWorthCard } from "@/components/dashboard/NetWorthCard";
// import { InsightList } from "@/components/dashboard/InsightList";
// import { MlInsightsPanel } from "@/components/dashboard/MlInsightsPanel";

// export default function DashboardPage() {
//   const [summary, setSummary] = useState<DashboardSummaryDTO | null>(null);
//   const [error, setError] = useState<string | null>(null);

//   useEffect(() => {
//     api.dashboard
//       .summary()
//       .then(setSummary)
//       .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your dashboard."));
//   }, []);

//   if (error) {
//     return <p className="text-sm text-loss">{error}</p>;
//   }

//   if (!summary) {
//     return <p className="text-sm text-ink-faint">Loading your numbers…</p>;
//   }

//   return (
//     <div className="space-y-6">
//       <div>
//         <h1 className="font-display text-2xl text-ink">Home</h1>
//         <p className="text-sm text-ink-soft">Your daily financial health, in one place.</p>
//       </div>
//       <div className="grid gap-6 md:grid-cols-2">
//         <HealthScoreCard score={summary.healthScore} />
//         <NetWorthCard summary={summary} />
//       </div>
//       <InsightList insights={summary.insights} />
//       <MlInsightsPanel />
//     </div>
//   );
// }






"use client";

import { useEffect, useState } from "react";
import type { DashboardOverviewDTO, DashboardSummaryDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { useFinancialVersion } from "@/lib/financial-events";
import { HealthScoreCard } from "@/components/dashboard/HealthScoreCard";
import { NetWorthCard } from "@/components/dashboard/NetWorthCard";
import { InsightList } from "@/components/dashboard/InsightList";
import { MlInsightsPanel } from "@/components/dashboard/MlInsightsPanel";
import { DataHealthCard } from "@/components/dashboard/DataHealthCard";
import { MoneyOverview } from "@/components/dashboard/MoneyOverview";
import { QuickAddMenu } from "@/components/dashboard/QuickAddMenu";

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummaryDTO | null>(null);
  const [overview, setOverview] = useState<DashboardOverviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  // Any money movement elsewhere in the app (quick expense, repayment, SIP, reserve entry ...) bumps
  // this, so the numbers below refresh without a browser reload.
  const version = useFinancialVersion();

  useEffect(() => {
    api.dashboard
      .summary()
      .then((s) => {
        setSummary(s);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your dashboard."));
    api.dashboard
      .overview()
      .then((o) => {
        setOverview(o);
        setOverviewError(null);
      })
      .catch((err) => setOverviewError(err instanceof ApiError ? err.message : "Could not load your money flow."));
  }, [version]);

  if (error) {
    return (
      <div className="panel border-loss/30 bg-loss/5 p-5 text-sm text-loss">{error}</div>
    );
  }

  if (!summary) {
    return <p className="text-sm text-ink-faint">Loading your numbers…</p>;
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="stat-label mb-1">Dashboard</p>
          <h1 className="font-display text-2xl text-ink sm:text-3xl">Home</h1>
          <p className="mt-1 text-sm text-ink-soft">Your daily financial health, in one place.</p>
        </div>
        <QuickAddMenu />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <HealthScoreCard score={summary.healthScore} />
        <NetWorthCard summary={summary} />
      </div>
      {overview ? (
        <MoneyOverview overview={overview} />
      ) : overviewError ? (
        <div role="alert" className="panel border-loss/30 bg-loss/5 p-4 text-sm text-loss">{overviewError}</div>
      ) : (
        <p className="text-sm text-ink-faint">Loading where your money went…</p>
      )}
      <DataHealthCard />
      <InsightList insights={summary.insights} />
      <MlInsightsPanel />
    </div>
  );
}
