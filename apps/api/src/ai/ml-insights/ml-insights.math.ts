// PURE MODULE — same discipline as simulator.engine.ts: no Prisma, no service calls,
// no I/O. Every function takes plain numeric data in and returns plain data out.
// These are genuine, named statistical methods (documented per-function), not a
// single opaque "ML model" — per the roadmap's own instruction, a documented baseline
// method is fine, but it has to actually be the method it claims to be.

export interface RegressionResult {
  slope: number;
  intercept: number;
  /** R² — fraction of variance explained by the linear fit, used as this model's
   * confidence signal (a poor fit means a forecast built from it should be trusted
   * less). 0 when there are fewer than 2 points or the fit is undefined. */
  rSquared: number;
  predict: (x: number) => number;
}

/** Ordinary least-squares linear regression — the actual textbook formula, not an
 * approximation. Used by CashflowForecastModel to project a trend forward. */
export function linearRegression(points: { x: number; y: number }[]): RegressionResult {
  const n = points.length;
  if (n < 2) {
    const mean = n === 1 ? points[0].y : 0;
    return { slope: 0, intercept: mean, rSquared: 0, predict: () => mean };
  }

  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    numerator += (p.x - meanX) * (p.y - meanY);
    denominator += (p.x - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const predicted = slope * p.x + intercept;
    ssRes += (p.y - predicted) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }
  const rSquared = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : Math.max(0, 1 - ssRes / ssTot);

  return { slope, intercept, rSquared, predict: (x: number) => slope * x + intercept };
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1); // sample stdev (n-1)
  return Math.sqrt(variance);
}

/** Median absolute deviation — a robust (outlier-resistant) alternative to standard
 * deviation, used for anomaly detection precisely because a single huge outlier
 * shouldn't inflate the very spread measure used to detect outliers (which plain
 * stdev is prone to). Returns the median and the scaled MAD (× 1.4826, the standard
 * constant that makes it comparable to a normal distribution's stdev). */
export function medianAbsoluteDeviation(values: number[]): { median: number; mad: number } {
  if (values.length === 0) return { median: 0, mad: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const deviations = sorted.map((v) => Math.abs(v - median));
  const mad = percentile([...deviations].sort((a, b) => a - b), 0.5) * 1.4826;
  return { median, mad };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = p * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

/** Robust z-score using MAD instead of stdev — how many "MAD units" a value sits from
 * the median. |modifiedZ| > 3.5 is the commonly cited outlier threshold (Iglewicz &
 * Hoaglin, 1993), used as-is here rather than an arbitrary cutoff. */
export function modifiedZScore(value: number, medianVal: number, mad: number): number {
  if (mad === 0) return 0;
  return (0.6745 * (value - medianVal)) / mad;
}

/** Two-sample (Welch's) z-test comparing the means of two windows of the same metric
 * — the actual statistical test for "did this genuinely shift", not just "is the
 * second average a bit different". Returns a z-statistic; by convention |z| > 1.96
 * corresponds to roughly a 95% confidence the difference isn't just noise, used as
 * DriftDetectionModel's significance threshold. */
export function twoWindowZTest(windowA: number[], windowB: number[]): { z: number; meanA: number; meanB: number } {
  const meanA = mean(windowA);
  const meanB = mean(windowB);
  const varA = stdDev(windowA) ** 2;
  const varB = stdDev(windowB) ** 2;
  const nA = windowA.length;
  const nB = windowB.length;
  if (nA < 2 || nB < 2) return { z: 0, meanA, meanB };

  const standardError = Math.sqrt(varA / nA + varB / nB);
  if (standardError === 0) {
    // Both windows have zero internal variance — if their means also match, there is
    // genuinely no difference (z = 0); if the means differ at all, that is the most
    // significant possible result (identical, noise-free windows that still moved),
    // not "no difference". A large finite sentinel (well past the 1.96 significance
    // threshold) represents that correctly without producing Infinity/NaN downstream.
    return { z: meanA === meanB ? 0 : Math.sign(meanB - meanA) * 100, meanA, meanB };
  }
  const z = (meanB - meanA) / standardError;
  return { z, meanA, meanB };
}

/** Standard logistic function, used to turn an unbounded "how far ahead/behind
 * schedule" ratio into a bounded 0-1 probability for GoalSuccessModel — the same
 * function logistic regression uses to map a linear score to a probability, applied
 * here to a hand-specified linear score rather than a fitted one (see
 * GoalSuccessModel's own doc comment for why that's an honest baseline, not a
 * trained classifier).
 */
export function logistic(x: number, steepness = 1): number {
  return 1 / (1 + Math.exp(-steepness * x));
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
