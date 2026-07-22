"use client";

import { useEffect, useState } from "react";
import type { DashboardSummaryDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { HealthScoreCard } from "@/components/dashboard/HealthScoreCard";
import { NetWorthCard } from "@/components/dashboard/NetWorthCard";
import { InsightList } from "@/components/dashboard/InsightList";
import { MlInsightsPanel } from "@/components/dashboard/MlInsightsPanel";

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummaryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dashboard
      .summary()
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your dashboard."));
  }, []);

  if (error) {
    return <p className="text-sm text-loss">{error}</p>;
  }

  if (!summary) {
    return <p className="text-sm text-ink-faint">Loading your numbers…</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Home</h1>
        <p className="text-sm text-ink-soft">Your daily financial health, in one place.</p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <HealthScoreCard score={summary.healthScore} />
        <NetWorthCard summary={summary} />
      </div>
      <InsightList insights={summary.insights} />
      <MlInsightsPanel />
    </div>
  );
}
