import {
  linearRegression,
  mean,
  stdDev,
  medianAbsoluteDeviation,
  modifiedZScore,
  twoWindowZTest,
  logistic,
  clamp01,
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
