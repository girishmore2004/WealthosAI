import { Injectable } from "@nestjs/common";
import { twoWindowZTest, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export interface ForecastActualPair {
  /** YYYY-MM — the month a past forecast was made FOR (not the month it was made in). */
  targetMonth: string;
  predictedNetCashflow: number;
  actualNetCashflow: number;
}

export interface ConceptDriftPrediction {
  /** False when there isn't yet enough resolved forecast history to say anything —
   * distinct from `driftDetected: false`, which means "monitored, and stable". */
  monitored: boolean;
  driftDetected: boolean;
  recentMeanAbsoluteError: number;
  priorMeanAbsoluteError: number;
  sampleSize: number;
  zStatistic: number;
  direction: "degrading" | "improving" | "stable";
}

const WINDOW_SIZE = 3;
const SIGNIFICANCE_Z = 1.96; // ~95% confidence under a normal approximation — same convention as DriftDetectionModel

// "Concept drift" here means monitoring the CASHFLOW FORECAST MODEL'S OWN ACCURACY
// over time — is the relationship it's modeling (personal baseline + recent trend ->
// next month's actual net cashflow) still holding, or has the user's financial
// behavior shifted enough that the model's own predictions are becoming
// systematically worse. This is a genuinely different question from
// DriftDetectionModel (which asks "has the USER's savings rate itself shifted") —
// this model asks "has the FORECASTER's error gotten worse", i.e. real
// model-performance monitoring, not a second copy of spending-drift detection wearing
// a different name. Input `pairs` are built by the orchestrator
// (MlInsightsService) from MlInsightRun history — each past run's stored
// nextMonthProjectedCashflow, matched against the actual net cashflow now that the
// target month has passed — so this model itself stays a pure function over already-
// resolved (predicted, actual) pairs, same discipline as every other model here.
@Injectable()
export class ConceptDriftModel {
  detect(pairs: ForecastActualPair[]): ModelOutput<ConceptDriftPrediction> {
    if (pairs.length < WINDOW_SIZE * 2) {
      return {
        method: "Two-window (Welch's) z-test on rolling forecast absolute error (predicted vs. realized next-month net cashflow)",
        prediction: {
          monitored: false,
          driftDetected: false,
          recentMeanAbsoluteError: 0,
          priorMeanAbsoluteError: 0,
          sampleSize: pairs.length,
          zStatistic: 0,
          direction: "stable",
        },
        confidence: 0,
        contributingFeatures: [],
        explanation: `Need at least ${WINDOW_SIZE * 2} resolved monthly forecasts (a forecast made, then compared against the actual once that month passed) to monitor forecast accuracy over time — only ${pairs.length} available so far.`,
      };
    }

    const errors = pairs.map((p) => Math.abs(p.predictedNetCashflow - p.actualNetCashflow));
    const recent = errors.slice(-WINDOW_SIZE);
    const prior = errors.slice(-WINDOW_SIZE * 2, -WINDOW_SIZE);
    const { z, meanA, meanB } = twoWindowZTest(prior, recent);

    const driftDetected = Math.abs(z) >= SIGNIFICANCE_Z;
    // z > 0 here means the RECENT window's error mean is higher than the PRIOR
    // window's — that's the forecaster getting WORSE ("degrading"), the opposite sign
    // convention from DriftDetectionModel's savings-rate test (where a positive z
    // meant the metric itself improved) — worth calling out explicitly since the same
    // z sign means something different in each model.
    const direction: ConceptDriftPrediction["direction"] = !driftDetected ? "stable" : z > 0 ? "degrading" : "improving";

    return {
      method: "Two-window (Welch's) z-test on rolling forecast absolute error (predicted vs. realized next-month net cashflow)",
      prediction: {
        monitored: true,
        driftDetected,
        recentMeanAbsoluteError: meanB,
        priorMeanAbsoluteError: meanA,
        sampleSize: pairs.length,
        zStatistic: Number(z.toFixed(2)),
        direction,
      },
      confidence: clamp01(pairs.length / 12),
      contributingFeatures: [
        { name: `Prior ${WINDOW_SIZE}-month avg forecast error (₹)`, value: Number(meanA.toFixed(0)), contribution: 0.5 },
        { name: `Recent ${WINDOW_SIZE}-month avg forecast error (₹)`, value: Number(meanB.toFixed(0)), contribution: 0.5 },
      ],
      explanation: !driftDetected
        ? `No statistically significant change in the cashflow forecast model's own error — prior ${WINDOW_SIZE}-month avg error ₹${meanA.toFixed(0)}, recent ${WINDOW_SIZE}-month avg error ₹${meanB.toFixed(0)}.`
        : `The cashflow forecast model's error has significantly ${direction === "degrading" ? "worsened" : "improved"} — from an average error of ₹${meanA.toFixed(0)} to ₹${meanB.toFixed(0)} (z = ${z.toFixed(2)})${direction === "degrading" ? ". This may mean recent financial behavior has shifted enough that the model's assumptions are due for a re-check." : "."}`,
    };
  }
}
