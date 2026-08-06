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
 * approximation. Used by CashflowForecastModel/MetricsForecastModel to project a
 * trend forward and to detrend a series before decomposition. */
export function linearRegression(points: { x: number; y: number }[]): RegressionResult {
  const n = points.length;
  if (n < 2) {
    const mean_ = n === 1 ? points[0].y : 0;
    return { slope: 0, intercept: mean_, rSquared: 0, predict: () => mean_ };
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

/** Standard error of the mean — stdDev / sqrt(n). Used as the base uncertainty input
 * for confidence intervals on any per-window average this module reports. */
export function standardError(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  return stdDev(values) / Math.sqrt(n);
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
  let mad = percentile([...deviations].sort((a, b) => a - b), 0.5) * 1.4826;
  // Degenerate case: when a majority of values sit exactly at the median (e.g. a
  // stable recurring amount with one sharp spike), the *median* of deviations is 0
  // even though the data clearly isn't uniform — that 0 would otherwise silently
  // disable outlier detection via modifiedZScore's zero-MAD guard. Fall back to the
  // *mean* absolute deviation in that case, which the spike still pulls above 0.
  // Genuinely uniform data (every deviation is 0) leaves meanDeviation at 0 too, so
  // this doesn't change that case at all.
  if (mad === 0) {
    const meanDeviation = deviations.reduce((sum, d) => sum + d, 0) / deviations.length;
    if (meanDeviation > 0) mad = meanDeviation;
  }
  return { median, mad };
}

/** Linear-interpolated percentile of an already-sorted array (0 <= p <= 1). Exported
 * (not just an internal helper of medianAbsoluteDeviation) because
 * populationStabilityIndex also needs real quantile bucket edges, not a re-implemented
 * copy of the same interpolation logic. */
export function percentile(sortedValues: number[], p: number): number {
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
 * DriftDetectionModel's (and ConceptDriftModel's) significance threshold. */
export function twoWindowZTest(windowA: number[], windowB: number[]): { z: number; meanA: number; meanB: number } {
  const meanA = mean(windowA);
  const meanB = mean(windowB);
  const varA = stdDev(windowA) ** 2;
  const varB = stdDev(windowB) ** 2;
  const nA = windowA.length;
  const nB = windowB.length;
  if (nA < 2 || nB < 2) return { z: 0, meanA, meanB };

  const standardErr = Math.sqrt(varA / nA + varB / nB);
  if (standardErr === 0) {
    // Both windows have zero internal variance — if their means also match, there is
    // genuinely no difference (z = 0); if the means differ at all, that is the most
    // significant possible result (identical, noise-free windows that still moved),
    // not "no difference". A large finite sentinel (well past the 1.96 significance
    // threshold) represents that correctly without producing Infinity/NaN downstream.
    return { z: meanA === meanB ? 0 : Math.sign(meanB - meanA) * 100, meanA, meanB };
  }
  const z = (meanB - meanA) / standardErr;
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

// --- Advanced probabilistic primitives (Phase 14.1 upgrade) -------------------------
//
// Everything below this line adds the statistical machinery ML Insights needed to
// move from single point estimates to real probabilistic outputs: a Bayesian
// posterior update, an inverse-normal-CDF for arbitrary quantiles, a small
// t-distribution critical-value table for small-sample confidence intervals, additive
// time-series decomposition, and the Population Stability Index used for feature-drift
// monitoring. Same rules as the rest of this file: pure functions, no I/O, every
// formula named and documented so a reviewer can check it against the textbook/paper
// it claims to implement rather than trusting a comment.

/** Inverse standard normal CDF (the probit function) via Peter Acklam's rational
 * approximation — a well-known, widely used closed-form approximation (accurate to
 * roughly 1.15×10⁻⁹ relative error) that avoids needing a numerical-integration
 * library just to turn a probability like 0.10/0.90 into a z-value. Used by
 * normalQuantile() below to produce arbitrary quantiles (not just the fixed
 * 1.96/2.576 z-values a lookup table would give). */
export function invNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** The p-th quantile of a Normal(mean, sd²) distribution — e.g.
 * normalQuantile(mean, sd, 0.1) is the 10th-percentile forecast value. This is the
 * actual definition of a quantile forecast (not a heuristic band), built directly on
 * invNormalCdf(). Returns `mean_` unchanged when sd <= 0 (a degenerate, zero-
 * uncertainty distribution has every quantile equal to its mean). */
export function normalQuantile(mean_: number, sd: number, p: number): number {
  if (sd <= 0) return mean_;
  return mean_ + sd * invNormalCdf(p);
}

// Two-tailed 95% critical values from the Student's t-distribution, by degrees of
// freedom — the standard published table (e.g. any intro-stats textbook appendix),
// used instead of the fixed z=1.96 normal approximation specifically because ML
// Insights' forecasts are built from as few as 4-12 monthly observations, where the
// t-distribution's fatter tails matter and a normal approximation would understate
// the true interval width. Falls back to the z=1.96 asymptote for df >= 120, where
// the t and normal distributions are indistinguishable for this app's purposes.
const T_TABLE_95: [number, number][] = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365],
  [8, 2.306], [9, 2.262], [10, 2.228], [12, 2.179], [15, 2.131], [20, 2.086],
  [25, 2.060], [30, 2.042], [40, 2.021], [60, 2.000], [120, 1.980],
];

export function tCriticalValue95(degreesOfFreedom: number): number {
  const df = Math.max(1, Math.round(degreesOfFreedom));
  if (df >= 120) return 1.96;
  for (const [tableDf, value] of T_TABLE_95) {
    if (df <= tableDf) return value;
  }
  return 1.96;
}

/** 95% confidence interval around a point estimate, using the t-critical value for
 * the given degrees of freedom (falls back to the normal 1.96 asymptote for large
 * samples via tCriticalValue95). This is the one place "confidence interval" is
 * computed generically so every model that needs one (CashflowForecastModel,
 * MetricsForecastModel) uses the identical, correctly-small-sample-aware formula
 * rather than each hand-rolling ± a fixed multiple of standard deviation. */
export function confidenceInterval95(
  pointEstimate: number,
  stdErr: number,
  degreesOfFreedom: number,
): { lower: number; upper: number; marginOfError: number } {
  const critical = tCriticalValue95(degreesOfFreedom);
  const marginOfError = critical * Math.max(stdErr, 0);
  return { lower: pointEstimate - marginOfError, upper: pointEstimate + marginOfError, marginOfError };
}

export interface BayesianPosterior {
  posteriorMean: number;
  posteriorVar: number;
}

/** Conjugate Normal-Normal Bayesian update with known (estimated) variance — the
 * textbook formula: given a prior belief N(priorMean, priorVar) about a metric's true
 * level, and `n` new observations with sample mean/variance (sampleMean, sampleVar),
 * the posterior is also Normal with precision (1/variance) equal to the sum of the
 * prior's precision and the data's precision, and mean equal to the precision-
 * weighted average of the two. This is how ML Insights blends "your personal
 * long-run baseline" (the prior) with "what happened recently" (the likelihood) into
 * a single forecast that shrinks toward the user's own history when recent data is
 * noisy/thin (low data precision) and trusts recent data more as it accumulates —
 * genuine Bayesian shrinkage, not a hand-tuned weighted average. */
export function bayesianNormalUpdate(
  priorMean: number,
  priorVar: number,
  sampleMean: number,
  sampleVar: number,
  n: number,
): BayesianPosterior {
  const safeSampleVar = sampleVar > 0 ? sampleVar : priorVar > 0 ? priorVar : 1;
  const safePriorVar = priorVar > 0 ? priorVar : safeSampleVar;

  if (n <= 0) return { posteriorMean: priorMean, posteriorVar: safePriorVar };

  const priorPrecision = 1 / safePriorVar;
  const dataPrecision = n / safeSampleVar;
  const posteriorPrecision = priorPrecision + dataPrecision;
  const posteriorVar = 1 / posteriorPrecision;
  const posteriorMean = posteriorVar * (priorMean * priorPrecision + sampleMean * dataPrecision);

  return { posteriorMean, posteriorVar };
}

export interface DecompositionResult {
  trend: number[];
  seasonal: number[];
  residual: number[];
  hasSeasonality: boolean;
  trendSlope: number;
}

// Need at least two full annual cycles before reporting a per-calendar-month seasonal
// index — with less than that, any month-of-year average is statistically
// indistinguishable from noise, and reporting one anyway would be exactly the kind of
// "looks precise, isn't real" number this codebase's ML Insights module has
// deliberately avoided elsewhere (see DebtRiskModel/GoalSuccessModel's own honesty
// framing).
const MIN_MONTHS_FOR_SEASONALITY = 24;

/** Classical additive time-series decomposition: value = trend + seasonal + residual.
 * Trend is estimated via OLS linear regression rather than a centered moving average
 * — a deliberate choice for this app's short (12-36 month) personal monthly series,
 * where a centered moving average over a 12-month period would leave up to a year of
 * edge months with an undefined trend value. Seasonal is the mean detrended value for
 * each calendar month-of-year (0-11), centered so the seasonal component always
 * averages to ~0 across the year (it never shifts the overall level, only
 * redistributes it across months) — computed only when there's enough history (see
 * MIN_MONTHS_FOR_SEASONALITY); otherwise `seasonal` is all zeros and `hasSeasonality`
 * is false, which callers must check before treating the seasonal component as
 * meaningful. Residual is whatever trend + seasonal don't explain. */
export function classicalDecomposition(values: number[], monthOfYear: number[], period = 12): DecompositionResult {
  const n = values.length;
  if (n === 0) return { trend: [], seasonal: [], residual: [], hasSeasonality: false, trendSlope: 0 };

  const regression = linearRegression(values.map((y, i) => ({ x: i, y })));
  const trend = values.map((_, i) => regression.predict(i));
  const detrended = values.map((v, i) => v - trend[i]);

  const hasSeasonality = n >= MIN_MONTHS_FOR_SEASONALITY;
  let seasonal = new Array(n).fill(0);

  if (hasSeasonality) {
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const m = monthOfYear[i] % period;
      buckets.set(m, [...(buckets.get(m) ?? []), detrended[i]]);
    }
    const indexByMonth = new Map<number, number>();
    for (const [m, arr] of buckets) indexByMonth.set(m, mean(arr));
    const overall = mean([...indexByMonth.values()]);
    for (const [m, v] of indexByMonth) indexByMonth.set(m, v - overall);
    seasonal = monthOfYear.map((m) => indexByMonth.get(m % period) ?? 0);
  }

  const residual = values.map((v, i) => v - trend[i] - seasonal[i]);
  return { trend, seasonal, residual, hasSeasonality, trendSlope: regression.slope };
}

export interface ForecastPoint {
  monthsAhead: number;
  mean: number;
  stdErr: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface BayesianForecastResult {
  pointForecasts: ForecastPoint[];
  confidenceInterval95: { lower: number; upper: number };
  decomposition: DecompositionResult;
  personalizedBaseline: { historicalMean: number; historicalStdDev: number };
  trendSlopePerMonth: number;
  fitQuality: number; // R² of the underlying trend regression
}

// How much pseudo-evidence weight the trend extrapolation gets in the Bayesian
// update, capped at this many "effective observations" — mirrors
// RECENT_WINDOW_FOR_BAYESIAN_UPDATE months of memory: enough that a well-fitting
// trend over a reasonable history gets trusted close to fully, not so much that a
// short/noisy history overwhelms the personal-baseline prior.
const RECENT_WINDOW_FOR_BAYESIAN_UPDATE = 6;

/** The shared forecasting engine behind CashflowForecastModel and
 * MetricsForecastModel: takes one metric's chronological history (`values`, oldest
 * first) plus each point's calendar month-of-year (for seasonality), and produces a
 * genuinely probabilistic multi-step-ahead forecast —
 *   1. Trend extrapolation: an OLS regression (the same one classicalDecomposition
 *      uses) is extrapolated one step past the last observed month — this is the
 *      "what does the recent trend alone predict" evidence.
 *   2. Bayesian personalization: the user's own full-history mean/variance is the
 *      PRIOR belief about their "true" typical level; the trend extrapolation above
 *      is the LIKELIHOOD evidence, weighted by how tightly the trend actually fits
 *      (low residual variance = confident evidence) and by how much history backs it
 *      (capped at RECENT_WINDOW_FOR_BAYESIAN_UPDATE effective observations). The
 *      conjugate update (bayesianNormalUpdate) blends prior and evidence into a
 *      posterior level estimate that shrinks toward the personal baseline when the
 *      trend fit is weak/noisy, and trusts the trend extrapolation almost fully when
 *      the fit is tight — this is what "personalized baseline" means concretely: the
 *      prior IS this user's own history, not a population-wide default.
 *   3. Trend continuation: the same OLS slope is added on top of the Bayesian
 *      1-month-ahead level for each month further out, so the forecast keeps moving
 *      in a genuine direction rather than reverting flat.
 *   4. Growing uncertainty: forecast variance for h months ahead is the posterior
 *      variance plus h × the trend-regression's residual variance — the standard
 *      shape (uncertainty compounds with horizon) used for OLS prediction intervals,
 *      applied here on top of the Bayesian posterior instead of a plain regression
 *      point estimate.
 *   5. Quantiles (P10/P50/P90) and a named 95% confidence interval for the 1-month-
 *      ahead point, both derived from the same forecast mean/variance via
 *      normalQuantile()/confidenceInterval95() rather than ad-hoc bands.
 *   6. Trend/seasonal/residual decomposition of the input series itself, for display
 *      alongside the forecast (see classicalDecomposition's own seasonality caveat).
 */
export function bayesianQuantileForecast(
  values: number[],
  monthOfYear: number[],
  horizons: number[] = [1, 2, 3],
): BayesianForecastResult {
  const n = values.length;
  if (n === 0) {
    return {
      pointForecasts: horizons.map((h) => ({ monthsAhead: h, mean: 0, stdErr: 0, p10: 0, p50: 0, p90: 0 })),
      confidenceInterval95: { lower: 0, upper: 0 },
      decomposition: { trend: [], seasonal: [], residual: [], hasSeasonality: false, trendSlope: 0 },
      personalizedBaseline: { historicalMean: 0, historicalStdDev: 0 },
      trendSlopePerMonth: 0,
      fitQuality: 0,
    };
  }

  const historicalMean = mean(values);
  const historicalStdDev = stdDev(values);

  const regression = linearRegression(values.map((y, i) => ({ x: i, y })));
  const residuals = values.map((v, i) => v - regression.predict(i));
  const rawResidualStdDev = stdDev(residuals);
  // A genuinely (near-)perfect trend fit should be trusted almost fully, not shrunk
  // halfway back to the personal baseline just because its residual variance rounds
  // to ~0 — floor it at a small fraction of the series' own spread (or 1, for a
  // literally constant series) purely to keep the Bayesian update numerically
  // well-defined, never to manufacture doubt about a fit that isn't actually noisy.
  const residualStdDev = rawResidualStdDev > 0 ? rawResidualStdDev : Math.max(historicalStdDev * 0.05, 1);

  const oneStepAheadTrend = regression.predict(n); // OLS extrapolated one month past the last observed point
  const evidenceN = Math.min(RECENT_WINDOW_FOR_BAYESIAN_UPDATE, n);
  const priorVar = (historicalStdDev || residualStdDev || 1) ** 2;

  const { posteriorMean, posteriorVar } = bayesianNormalUpdate(
    historicalMean,
    priorVar,
    oneStepAheadTrend,
    residualStdDev ** 2,
    evidenceN,
  );

  const pointForecasts: ForecastPoint[] = horizons.map((h) => {
    const forecastMean = posteriorMean + regression.slope * (h - 1);
    const forecastVar = posteriorVar + residualStdDev ** 2 * h;
    const stdErr = Math.sqrt(Math.max(forecastVar, 0));
    return {
      monthsAhead: h,
      mean: forecastMean,
      stdErr,
      p10: normalQuantile(forecastMean, stdErr, 0.1),
      p50: normalQuantile(forecastMean, stdErr, 0.5),
      p90: normalQuantile(forecastMean, stdErr, 0.9),
    };
  });

  const oneMonthAhead = pointForecasts[0];
  const ci95 = confidenceInterval95(oneMonthAhead.mean, oneMonthAhead.stdErr, Math.max(1, n - 2));
  const decomposition = classicalDecomposition(values, monthOfYear);

  return {
    pointForecasts,
    confidenceInterval95: { lower: ci95.lower, upper: ci95.upper },
    decomposition,
    personalizedBaseline: { historicalMean, historicalStdDev },
    trendSlopePerMonth: regression.slope,
    fitQuality: regression.rSquared,
  };
}

/** Population Stability Index (PSI) between a reference distribution and a current
 * one — the standard industry metric production ML systems use for online feature-
 * drift monitoring (see e.g. Siddiqi, "Credit Risk Scorecards"), computed here
 * in-process against a user's own transaction history instead of a served model's
 * live traffic. Bucket edges are the reference window's own quintiles (or however
 * many `buckets` requested), so PSI answers "how much of the CURRENT window's mass
 * falls in each bucket that used to hold an even share of the REFERENCE window" —
 * PSI < 0.1 is conventionally read as no meaningful shift, 0.1-0.25 as a moderate
 * shift worth watching, and > 0.25 as a significant shift warranting investigation —
 * published thresholds, not invented for this app. */
export function populationStabilityIndex(reference: number[], current: number[], buckets = 5): number {
  if (reference.length < buckets || current.length === 0) return 0;

  const sortedRef = [...reference].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let i = 1; i < buckets; i++) edges.push(percentile(sortedRef, i / buckets));

  const bucketOf = (value: number): number => {
    let idx = 0;
    while (idx < edges.length && value > edges[idx]) idx++;
    return idx;
  };

  const refCounts = new Array(buckets).fill(0);
  for (const v of reference) refCounts[bucketOf(v)]++;
  const curCounts = new Array(buckets).fill(0);
  for (const v of current) curCounts[bucketOf(v)]++;

  const EPS = 1e-6; // avoids log(0)/division-by-zero when a bucket is empty in either window
  let psi = 0;
  for (let b = 0; b < buckets; b++) {
    const refPct = Math.max(refCounts[b] / reference.length, EPS);
    const curPct = Math.max(curCounts[b] / current.length, EPS);
    psi += (curPct - refPct) * Math.log(curPct / refPct);
  }
  return psi;
}

/** Coefficient of variation — stdDev / mean, the standard scale-free way to compare
 * "how volatile" two series are when their absolute levels differ (₹40,000/month
 * expenses varying by ₹4,000 is exactly as volatile, relatively, as ₹4,000/month
 * varying by ₹400 — plain stdDev alone can't say that, CV can). Returns 0 when the
 * mean is 0 rather than dividing by zero. */
export function coefficientOfVariation(values: number[]): number {
  const m = mean(values);
  if (m === 0) return 0;
  return Math.abs(stdDev(values) / m);
}

/** Herfindahl-Hirschman Index — sum of squared shares, the standard concentration
 * measure (used for market concentration; applied here to a user's own category
 * spend shares). Ranges from ~1/N (perfectly even across N categories) to 1 (all
 * spend in one category) — a real, named concentration statistic, not an arbitrary
 * "top category %" heuristic. Returns 0 when total is 0 (nothing to concentrate). */
export function herfindahlIndex(shares: number[]): number {
  const total = shares.reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  return shares.reduce((s, v) => s + (v / total) ** 2, 0);
}

/** Maps a value to 0-1 using its distance (in MAD units, capped at `capZ`) from a
 * personal median — a robust, outlier-resistant "how extreme is this for this user"
 * normalization, used for personalized-baseline feature scaling. 0.5 = exactly at the
 * user's own median; 0 or 1 = at or beyond `capZ` MAD units below/above it. */
export function robustNormalize01(value: number, median: number, mad: number, capZ = 3.5): number {
  if (mad === 0) return 0.5;
  const z = (value - median) / mad;
  return clamp01((z + capZ) / (2 * capZ));
}
