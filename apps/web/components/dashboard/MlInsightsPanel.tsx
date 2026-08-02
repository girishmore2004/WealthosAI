"use client";

import { useEffect, useState } from "react";
import type { MlInsightsSummaryDTO } from "@wealthos/types";
import { api } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { formatINR } from "@/lib/format";

// Deliberately a separate component with its own fetch, not folded into
// DashboardSummaryDTO/InsightList — those stay exactly the deterministic,
// DB-grounded rules they've always been (Phase 9). This panel is explicitly the
// "statistical, not rule-based" section the roadmap asked for, and says so in its own
// copy rather than blending in.
export function MlInsightsPanel() {
  const [summary, setSummary] = useState<MlInsightsSummaryDTO | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.mlInsights
      .summary()
      .then(setSummary)
      .catch(() => setError(true));
  }, []);

  if (error || !summary) return null;

  const { anomalies, cashflowForecast, debtRisk, drift, goalSuccess, habitSegmentation } = summary;

  // All 6 models are computed on every request (see MlInsightsService.summary) — this
  // panel previously only ever rendered 4 of them. goalSuccess and habitSegmentation
  // were fetched and paid for on every dashboard load but never shown to the user.
  // The two lines below are the only change needed to actually surface them: an
  // at-risk goal is "notable" the same way a debt-risk tier above "low" is, and a
  // month whose habit z-score has moved a full standard deviation off the user's own
  // baseline (state !== "balanced") is "notable" the same way a drift flag is —
  // "balanced" is business-as-usual and stays quiet, matching the existing pattern of
  // only surfacing signals worth a second look.
  const atRiskGoals = goalSuccess.prediction.filter((g) => g.successProbability < 0.5);
  const mostRecentSegment = habitSegmentation.prediction[habitSegmentation.prediction.length - 1];
  const habitSegmentationNotable = mostRecentSegment != null && mostRecentSegment.state !== "balanced";

  const hasAnySignal =
    anomalies.prediction.length > 0 ||
    cashflowForecast.prediction.stressRisk ||
    debtRisk.prediction.tier !== "low" ||
    drift.prediction.drifted ||
    atRiskGoals.length > 0 ||
    habitSegmentationNotable;

  return (
    <Card eyebrow="Statistical signals (not rule-based)" title="What the numbers suggest">
      <p className="mb-3 text-xs text-ink-faint">
        Computed from your own data using real statistical methods (regression, z-scores, a weighted scorecard) —
        separate from the rule-based insights above, and not always right. See each item&apos;s method for how it
        was derived.
      </p>

      {!hasAnySignal ? (
        <p className="text-sm text-ink-soft">No notable statistical signals this month.</p>
      ) : (
        <div className="space-y-3">
          {anomalies.prediction.length > 0 && (
            <SignalRow
              label="Unusual spending"
              detail={anomalies.explanation}
              confidence={anomalies.confidence}
            />
          )}
          {cashflowForecast.prediction.stressRisk && (
            <SignalRow
              label="Cashflow stress forecast"
              detail={`Next month projected at ${formatINR(cashflowForecast.prediction.nextMonthProjectedCashflow)}.`}
              confidence={cashflowForecast.confidence}
            />
          )}
          {debtRisk.prediction.tier !== "low" && (
            <SignalRow label={`Debt risk: ${debtRisk.prediction.tier}`} detail={debtRisk.explanation} confidence={debtRisk.confidence} />
          )}
          {drift.prediction.drifted && (
            <SignalRow label="Trend change detected" detail={drift.explanation} confidence={drift.confidence} />
          )}
          {atRiskGoals.length > 0 && (
            <SignalRow
              label={`Goal success risk (${atRiskGoals.length} of ${goalSuccess.prediction.length})`}
              detail={goalSuccess.explanation}
              confidence={goalSuccess.confidence}
            />
          )}
          {habitSegmentationNotable && mostRecentSegment && (
            <SignalRow
              label={`Spending pattern: ${capitalizeWords(mostRecentSegment.state.replace("_", " "))}`}
              detail={habitSegmentation.explanation}
              confidence={habitSegmentation.confidence}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function SignalRow({ label, detail, confidence }: { label: string; detail: string; confidence: number }) {
  return (
    <div className="border-b border-line pb-2 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">{label}</p>
        <span className="font-mono text-[11px] text-ink-faint">{Math.round(confidence * 100)}% confidence</span>
      </div>
      <p className="mt-1 text-xs text-ink-soft">{detail}</p>
    </div>
  );
}

function capitalizeWords(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}
