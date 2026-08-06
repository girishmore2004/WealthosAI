"use client";

import { useEffect, useState } from "react";
import type { MlInsightsSummaryDTO } from "@wealthos/types";
import { api } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
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

  const {
    anomalies,
    anomalyExplanation,
    cashflowForecast,
    debtRisk,
    drift,
    conceptDrift,
    featureMonitoring,
    goalSuccess,
    habitSegmentation,
    behavioralFeatures,
  } = summary;

  // All models are computed on every request (see MlInsightsService.summary) — this
  // panel only surfaces the ones worth a second look, same "notable, not exhaustive"
  // pattern for every signal below: an at-risk goal is "notable" the same way a
  // debt-risk tier above "low" is, a month whose habit z-score has moved a full
  // standard deviation off the user's own baseline is "notable" the same way a drift
  // flag is, and a behavioral cluster is only shown when it isn't the unremarkable
  // "steady, balanced" default.
  const atRiskGoals = goalSuccess.prediction.filter((g) => g.successProbability < 0.5);
  const mostRecentSegment = habitSegmentation.prediction[habitSegmentation.prediction.length - 1];
  const habitSegmentationNotable = mostRecentSegment != null && mostRecentSegment.state !== "balanced";
  const behavioralClusterNotable = behavioralFeatures.confidence > 0 && behavioralFeatures.prediction.cluster !== "steady_balanced";
  const oneMonthQuantile = cashflowForecast.prediction.quantileForecast[0];

  const hasAnySignal =
    anomalies.prediction.length > 0 ||
    cashflowForecast.prediction.stressRisk ||
    debtRisk.prediction.tier !== "low" ||
    drift.prediction.drifted ||
    conceptDrift.prediction.driftDetected ||
    featureMonitoring.prediction.anyShiftDetected ||
    atRiskGoals.length > 0 ||
    habitSegmentationNotable ||
    behavioralClusterNotable;

  return (
    <Card eyebrow="Statistical signals (not rule-based)" title="What the numbers suggest">
      <p className="mb-3 text-xs text-ink-faint">
        Computed from your own data using real statistical and probabilistic methods (Bayesian forecasting, time-series
        decomposition, z-scores, a weighted scorecard) — separate from the rule-based insights above, and not always
        right. See each item&apos;s method for how it was derived.
      </p>

      {!hasAnySignal ? (
        <p className="rounded-md bg-surface-muted px-3 py-3 text-sm text-ink-soft">
          No notable statistical signals this month.
        </p>
      ) : (
        <div className="space-y-1">
          {anomalies.prediction.length > 0 && (
            <SignalRow
              label="Unusual spending"
              detail={anomalyExplanation.narrative}
              confidence={anomalyExplanation.usedFallback ? anomalies.confidence : anomalyExplanation.confidence}
              badge={anomalyExplanation.usedFallback ? "rule-based fallback" : undefined}
            />
          )}
          {cashflowForecast.prediction.stressRisk && (
            <SignalRow
              label="Cashflow stress forecast"
              detail={`Next month projected at ${formatINR(cashflowForecast.prediction.nextMonthProjectedCashflow)} (90% range ${formatINR(oneMonthQuantile.p10)} to ${formatINR(oneMonthQuantile.p90)}).`}
              confidence={cashflowForecast.confidence}
            />
          )}
          {debtRisk.prediction.tier !== "low" && (
            <SignalRow label={`Debt risk: ${debtRisk.prediction.tier}`} detail={debtRisk.explanation} confidence={debtRisk.confidence} />
          )}
          {drift.prediction.drifted && (
            <SignalRow label="Trend change detected" detail={drift.explanation} confidence={drift.confidence} />
          )}
          {conceptDrift.prediction.driftDetected && (
            <SignalRow
              label="Forecast accuracy has shifted"
              detail={conceptDrift.explanation}
              confidence={conceptDrift.confidence}
            />
          )}
          {featureMonitoring.prediction.anyShiftDetected && (
            <SignalRow
              label="Spending pattern shift detected"
              detail={featureMonitoring.explanation}
              confidence={featureMonitoring.confidence}
            />
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
          {behavioralClusterNotable && (
            <SignalRow
              label={`Spending profile: ${capitalizeWords(behavioralFeatures.prediction.cluster.replace("_", " "))}`}
              detail={behavioralFeatures.explanation}
              confidence={behavioralFeatures.confidence}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function SignalRow({
  label,
  detail,
  confidence,
  badge,
}: {
  label: string;
  detail: string;
  confidence: number;
  badge?: string;
}) {
  return (
    <div className="border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-ink">{label}</p>
          {badge && <Badge tone="info">{badge}</Badge>}
        </div>
        <span className="stat-value text-[11px] text-ink-faint">{Math.round(confidence * 100)}% confidence</span>
      </div>
      <p className="mt-1 text-xs text-ink-soft">{detail}</p>
    </div>
  );
}

function capitalizeWords(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}
