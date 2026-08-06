import {
  linearRegression,
  mean,
  stdDev,
  medianAbsoluteDeviation,
  modifiedZScore,
  twoWindowZTest,
  logistic,
  clamp01,
  invNormalCdf,
  normalQuantile,
  tCriticalValue95,
  confidenceInterval95,
  bayesianNormalUpdate,
  classicalDecomposition,
  bayesianQuantileForecast,
  populationStabilityIndex,
  coefficientOfVariation,
  herfindahlIndex,
  robustNormalize01,
  standardError,
} from "../src/ai/ml-insights/ml-insights.math";

describe("linearRegression", () => {
  it("fits a perfect line exactly (slope, intercept, R² = 1)", () => {
    const points = [0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 5 }));
    const result = linearRegression(points);
    expect(result.slope).toBeCloseTo(2);
    expect(result.intercept).toBeCloseTo(5);
    expect(result.rSquared).toBeCloseTo(1);
    expect(result.predict(5)).toBeCloseTo(15);
  });

  it("returns the single value as a flat prediction with 0 confidence signal for one point", () => {
    const result = linearRegression([{ x: 0, y: 42 }]);
    expect(result.slope).toBe(0);
    expect(result.predict(100)).toBe(42);
    expect(result.rSquared).toBe(0);
  });

  it("gives a low R² for noisy, non-linear-looking data", () => {
    const points = [
      { x: 0, y: 10 },
      { x: 1, y: -5 },
      { x: 2, y: 20 },
      { x: 3, y: -8 },
    ];
    const result = linearRegression(points);
    expect(result.rSquared).toBeLessThan(0.5);
  });
});

describe("mean / stdDev", () => {
  it("computes the arithmetic mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
  });

  it("returns 0 stdev for fewer than 2 values", () => {
    expect(stdDev([5])).toBe(0);
    expect(stdDev([])).toBe(0);
  });

  it("computes sample standard deviation correctly", () => {
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });
});

describe("medianAbsoluteDeviation / modifiedZScore", () => {
  it("is robust to a single extreme outlier (unlike plain stdev)", () => {
    const normalValues = [100, 102, 98, 101, 99, 100, 103];
    const withOutlier = [...normalValues, 10000];
    const { median, mad } = medianAbsoluteDeviation(withOutlier);
    // median barely moves with one outlier among 8 values
    expect(median).toBeGreaterThan(95);
    expect(median).toBeLessThan(105);
    // the outlier itself should register as an extreme modified z-score
    const z = modifiedZScore(10000, median, mad);
    expect(Math.abs(z)).toBeGreaterThan(3.5);
  });

  it("gives an in-range value a modified z-score near 0", () => {
    const values = [100, 102, 98, 101, 99, 100, 103];
    const { median, mad } = medianAbsoluteDeviation(values);
    const z = modifiedZScore(100, median, mad);
    expect(Math.abs(z)).toBeLessThan(1);
  });

  it("returns 0 z-score when MAD is 0 (no variation) rather than dividing by zero", () => {
    const { median, mad } = medianAbsoluteDeviation([50, 50, 50]);
    expect(mad).toBe(0);
    expect(modifiedZScore(999, median, mad)).toBe(0);
  });
});

describe("twoWindowZTest", () => {
  it("finds no significant difference between two similar windows", () => {
    const { z } = twoWindowZTest([0.2, 0.21, 0.19, 0.2], [0.2, 0.19, 0.21, 0.2]);
    expect(Math.abs(z)).toBeLessThan(1.96);
  });

  it("finds a significant difference when the windows clearly differ with low variance", () => {
    const { z } = twoWindowZTest([0.1, 0.1, 0.1, 0.1], [0.5, 0.5, 0.5, 0.5]);
    expect(Math.abs(z)).toBeGreaterThan(1.96);
  });

  it("returns z = 0 when either window has fewer than 2 points", () => {
    expect(twoWindowZTest([0.1], [0.2, 0.3]).z).toBe(0);
  });
});

describe("logistic / clamp01", () => {
  it("returns exactly 0.5 at x = 0", () => {
    expect(logistic(0)).toBe(0.5);
  });

  it("approaches 1 for large positive x and 0 for large negative x", () => {
    expect(logistic(10)).toBeGreaterThan(0.999);
    expect(logistic(-10)).toBeLessThan(0.001);
  });

  it("clamps values outside [0,1]", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
});

describe("invNormalCdf / normalQuantile", () => {
  it("returns ~0 at p = 0.5 (the standard normal's median)", () => {
    expect(invNormalCdf(0.5)).toBeCloseTo(0, 6);
  });

  it("matches well-known z-values for common tail probabilities", () => {
    expect(invNormalCdf(0.9)).toBeCloseTo(1.2816, 3);
    expect(invNormalCdf(0.1)).toBeCloseTo(-1.2816, 3);
    expect(invNormalCdf(0.975)).toBeCloseTo(1.96, 2);
  });

  it("normalQuantile scales/shifts by mean and sd", () => {
    expect(normalQuantile(100, 10, 0.5)).toBeCloseTo(100, 6);
    expect(normalQuantile(100, 10, 0.9)).toBeCloseTo(100 + 10 * 1.2816, 2);
  });

  it("normalQuantile returns the mean unchanged for sd <= 0 (degenerate distribution)", () => {
    expect(normalQuantile(50, 0, 0.9)).toBe(50);
    expect(normalQuantile(50, -1, 0.1)).toBe(50);
  });
});

describe("tCriticalValue95 / confidenceInterval95", () => {
  it("matches the standard published small-sample t-table values", () => {
    expect(tCriticalValue95(1)).toBeCloseTo(12.706, 2);
    expect(tCriticalValue95(10)).toBeCloseTo(2.228, 2);
  });

  it("falls back to the 1.96 normal asymptote for large degrees of freedom", () => {
    expect(tCriticalValue95(500)).toBe(1.96);
  });

  it("widens the interval for small samples vs. the normal approximation", () => {
    const smallSample = confidenceInterval95(100, 10, 3);
    const largeSample = confidenceInterval95(100, 10, 200);
    expect(smallSample.marginOfError).toBeGreaterThan(largeSample.marginOfError);
  });

  it("produces a symmetric interval around the point estimate", () => {
    const ci = confidenceInterval95(500, 20, 30);
    expect(ci.upper - 500).toBeCloseTo(500 - ci.lower, 6);
  });
});

describe("bayesianNormalUpdate", () => {
  it("shrinks toward the prior when the sample is thin/noisy relative to the prior", () => {
    // Strong, tight prior (low variance) vs. a single noisy observation far away —
    // the posterior should stay close to the prior mean, not jump to the sample.
    const { posteriorMean } = bayesianNormalUpdate(100, 1, 1000, 10000, 1);
    expect(posteriorMean).toBeLessThan(200);
    expect(posteriorMean).toBeGreaterThan(90);
  });

  it("trusts the sample more as n grows and the prior is weak/wide", () => {
    const { posteriorMean } = bayesianNormalUpdate(0, 100000, 50, 4, 30);
    expect(posteriorMean).toBeCloseTo(50, 0);
  });

  it("returns the prior unchanged when n <= 0", () => {
    const { posteriorMean, posteriorVar } = bayesianNormalUpdate(42, 9, 1000, 1, 0);
    expect(posteriorMean).toBe(42);
    expect(posteriorVar).toBe(9);
  });

  it("posterior variance is always less than both the prior and per-observation sample variance (real information gain)", () => {
    const { posteriorVar } = bayesianNormalUpdate(100, 25, 105, 16, 5);
    expect(posteriorVar).toBeLessThan(25);
  });
});

describe("classicalDecomposition", () => {
  it("recovers a clean linear trend with zero residual for a perfectly linear series", () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((x) => 10 + x * 5);
    const monthOfYear = values.map((_, i) => i % 12);
    const result = classicalDecomposition(values, monthOfYear);
    expect(result.trendSlope).toBeCloseTo(5, 5);
    result.residual.forEach((r) => expect(Math.abs(r)).toBeLessThan(1e-6));
  });

  it("does not report seasonality with fewer than 24 months of history", () => {
    const values = Array.from({ length: 12 }, (_, i) => 100 + i);
    const monthOfYear = values.map((_, i) => i % 12);
    const result = classicalDecomposition(values, monthOfYear);
    expect(result.hasSeasonality).toBe(false);
    expect(result.seasonal.every((s) => s === 0)).toBe(true);
  });

  it("detects a repeating seasonal pattern with 24+ months of history", () => {
    // December (index 11) is consistently +50 above an otherwise flat series across 3 years.
    const monthOfYear: number[] = [];
    const values: number[] = [];
    for (let year = 0; year < 3; year++) {
      for (let m = 0; m < 12; m++) {
        monthOfYear.push(m);
        values.push(100 + (m === 11 ? 50 : 0));
      }
    }
    const result = classicalDecomposition(values, monthOfYear);
    expect(result.hasSeasonality).toBe(true);
    const decemberIndices = monthOfYear.map((m, i) => (m === 11 ? i : -1)).filter((i) => i >= 0);
    const otherIndices = monthOfYear.map((m, i) => (m !== 11 ? i : -1)).filter((i) => i >= 0);
    const avgDecemberSeasonal = mean(decemberIndices.map((i) => result.seasonal[i]));
    const avgOtherSeasonal = mean(otherIndices.map((i) => result.seasonal[i]));
    expect(avgDecemberSeasonal).toBeGreaterThan(avgOtherSeasonal);
  });

  it("returns empty arrays for an empty series", () => {
    const result = classicalDecomposition([], []);
    expect(result.trend).toEqual([]);
    expect(result.hasSeasonality).toBe(false);
  });
});

describe("bayesianQuantileForecast", () => {
  it("orders quantiles correctly (p10 <= p50 <= p90) at every horizon", () => {
    const values = [100, 120, 110, 130, 125, 140, 135];
    const monthOfYear = values.map((_, i) => i % 12);
    const result = bayesianQuantileForecast(values, monthOfYear, [1, 2, 3]);
    for (const f of result.pointForecasts) {
      expect(f.p10).toBeLessThanOrEqual(f.p50);
      expect(f.p50).toBeLessThanOrEqual(f.p90);
    }
  });

  it("widens the forecast interval as the horizon extends further out", () => {
    const values = [100, 105, 102, 108, 110, 107, 115];
    const monthOfYear = values.map((_, i) => i % 12);
    const result = bayesianQuantileForecast(values, monthOfYear, [1, 2, 3]);
    const widths = result.pointForecasts.map((f) => f.p90 - f.p10);
    expect(widths[1]).toBeGreaterThan(widths[0]);
    expect(widths[2]).toBeGreaterThan(widths[1]);
  });

  it("shrinks the 1-month-ahead forecast toward the personal baseline when recent data is noisy", () => {
    // Stable long history, then one wild recent spike — the Bayesian forecast should
    // land somewhere between the long-run baseline and the noisy recent mean, not
    // just extrapolate the spike.
    const stable = new Array(10).fill(100);
    const noisy = [100, 100, 100, 500];
    const values = [...stable, ...noisy];
    const monthOfYear = values.map((_, i) => i % 12);
    const result = bayesianQuantileForecast(values, monthOfYear, [1]);
    const forecast = result.pointForecasts[0].mean;
    expect(forecast).toBeGreaterThan(90);
    expect(forecast).toBeLessThan(300);
  });

  it("returns a well-formed zeroed result for an empty series rather than throwing", () => {
    const result = bayesianQuantileForecast([], []);
    expect(result.pointForecasts).toHaveLength(3);
    expect(result.pointForecasts[0].mean).toBe(0);
    expect(result.personalizedBaseline.historicalMean).toBe(0);
  });
});

describe("populationStabilityIndex", () => {
  it("is ~0 when the current window matches the reference distribution", () => {
    const reference = Array.from({ length: 100 }, (_, i) => i);
    const current = Array.from({ length: 100 }, (_, i) => i);
    expect(populationStabilityIndex(reference, current)).toBeCloseTo(0, 1);
  });

  it("is large when the current window has clearly shifted away from the reference", () => {
    const reference = Array.from({ length: 100 }, (_, i) => i); // 0..99
    const current = Array.from({ length: 100 }, (_, i) => i + 500); // 500..599, entirely outside reference range
    expect(populationStabilityIndex(reference, current)).toBeGreaterThan(0.25);
  });

  it("returns 0 when there isn't enough reference data for the requested bucket count", () => {
    expect(populationStabilityIndex([1, 2], [1, 2, 3], 5)).toBe(0);
  });
});

describe("coefficientOfVariation / herfindahlIndex / robustNormalize01 / standardError", () => {
  it("coefficientOfVariation is scale-invariant", () => {
    const cvSmall = coefficientOfVariation([100, 110, 90, 105, 95]);
    const cvLarge = coefficientOfVariation([1000, 1100, 900, 1050, 950]);
    expect(cvSmall).toBeCloseTo(cvLarge, 6);
  });

  it("coefficientOfVariation returns 0 for a zero mean rather than dividing by zero", () => {
    expect(coefficientOfVariation([0, 0, 0])).toBe(0);
  });

  it("herfindahlIndex is 1 when all spend is in one category and ~1/N when evenly split", () => {
    expect(herfindahlIndex([100, 0, 0, 0])).toBeCloseTo(1);
    expect(herfindahlIndex([25, 25, 25, 25])).toBeCloseTo(0.25);
  });

  it("herfindahlIndex returns 0 when total is 0", () => {
    expect(herfindahlIndex([0, 0])).toBe(0);
  });

  it("robustNormalize01 maps the median to 0.5 and clamps beyond capZ", () => {
    expect(robustNormalize01(100, 100, 10)).toBeCloseTo(0.5);
    expect(robustNormalize01(1000, 100, 10)).toBe(1);
    expect(robustNormalize01(-1000, 100, 10)).toBe(0);
  });

  it("standardError shrinks as sample size grows", () => {
    const seSmall = standardError([1, 2, 3]);
    const seLarge = standardError(Array.from({ length: 30 }, (_, i) => (i % 3) + 1));
    expect(seLarge).toBeLessThan(seSmall);
  });
});
