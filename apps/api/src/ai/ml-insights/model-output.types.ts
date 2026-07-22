export interface ContributingFeature {
  name: string;
  value: number;
  /** This feature's share of the final score/decision — for a weighted scorecard
   * (DebtRiskModel) this is the literal weight × normalized value; for a regression-
   * based model it's a qualitative "how much this moved the prediction" note encoded
   * numerically. Always present so a UI can render a real feature-importance bar, not
   * a decorative one. */
  contribution: number;
}

/** Every ML Insights model returns exactly this shape — the roadmap's own required
 * fields (prediction, confidence, contributing features, explanation), plus `method`
 * so the UI/docs can always say which actual statistical technique produced this,
 * never leaving it ambiguous whether something is a real computation or a vibe. */
export interface ModelOutput<T> {
  method: string;
  prediction: T;
  confidence: number;
  contributingFeatures: ContributingFeature[];
  explanation: string;
}
