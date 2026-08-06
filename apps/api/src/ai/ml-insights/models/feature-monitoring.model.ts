import { Injectable } from "@nestjs/common";
import { populationStabilityIndex, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export interface MonitoredFeatureWindow {
  name: string;
  reference: number[];
  current: number[];
}

export interface FeatureShiftResult {
  name: string;
  psi: number;
  severity: "none" | "moderate" | "significant";
}

export interface FeatureMonitoringPrediction {
  monitored: boolean;
  features: FeatureShiftResult[];
  anyShiftDetected: boolean;
}

// Population Stability Index (PSI) is the standard industry metric for detecting when
// a feature's distribution has shifted between a reference window and a current one —
// used here exactly the way production ML systems use it for online feature
// monitoring, just computed in-process against this user's own transaction history
// instead of a served model's live traffic. PSI < 0.1 is conventionally read as "no
// meaningful shift", 0.1-0.25 as "moderate, worth watching", and > 0.25 as
// "significant shift, investigate" — these are the standard published thresholds
// (Siddiqi, "Credit Risk Scorecards"), not invented for this app. Input windows are
// built by features/feature-monitoring-windows.util.ts from data
// FeatureExtractionService already fetched — this model itself only ever sees plain
// number arrays, same discipline as every other model in this module.
const PSI_MODERATE_THRESHOLD = 0.1;
const PSI_SIGNIFICANT_THRESHOLD = 0.25;
const MIN_POINTS_PER_WINDOW = 5;

@Injectable()
export class FeatureMonitoringModel {
  detect(windows: MonitoredFeatureWindow[]): ModelOutput<FeatureMonitoringPrediction> {
    const eligible = windows.filter((w) => w.reference.length >= MIN_POINTS_PER_WINDOW && w.current.length >= MIN_POINTS_PER_WINDOW);

    if (eligible.length === 0) {
      return {
        method: "Population Stability Index (PSI) between a reference window and a recent window, per engineered feature",
        prediction: { monitored: false, features: [], anyShiftDetected: false },
        confidence: 0,
        contributingFeatures: [],
        explanation: `Not enough data points per feature window (need at least ${MIN_POINTS_PER_WINDOW} in each) to monitor feature distribution shifts yet.`,
      };
    }

    const features: FeatureShiftResult[] = eligible.map((w) => {
      const psi = populationStabilityIndex(w.reference, w.current);
      const severity: FeatureShiftResult["severity"] =
        psi >= PSI_SIGNIFICANT_THRESHOLD ? "significant" : psi >= PSI_MODERATE_THRESHOLD ? "moderate" : "none";
      return { name: w.name, psi: Number(psi.toFixed(3)), severity };
    });

    const shifted = features.filter((f) => f.severity !== "none");

    return {
      method: "Population Stability Index (PSI) between a reference window and a recent window, per engineered feature",
      prediction: { monitored: true, features, anyShiftDetected: shifted.length > 0 },
      confidence: clamp01(eligible.length / windows.length),
      contributingFeatures: features.map((f) => ({ name: f.name, value: f.psi, contribution: f.psi })),
      explanation:
        shifted.length === 0
          ? "No monitored feature's distribution has shifted meaningfully between the reference and recent windows."
          : `${shifted.length} feature(s) show a ${shifted.some((f) => f.severity === "significant") ? "significant" : "moderate"} distribution shift vs. the reference window: ${shifted.map((f) => `${f.name} (PSI ${f.psi})`).join(", ")}.`,
    };
  }
}
