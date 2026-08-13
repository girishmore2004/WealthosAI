import { ScenarioLoanSnapshotDTO, ScenarioType } from "@wealthos/types";

// PURE MODULE — no Prisma, no service calls, no I/O of any kind, no calls to
// AiGatewayService. Same discipline as simulator.engine.ts: every function here takes
// plain data in and returns plain data out, so the same inputs always produce the same
// outputs and this file stays trivially unit-testable in isolation.
//
// Deliberately NOT merged into simulator.engine.ts: that file backs the plain
// Simulator feature (`/simulator/run`) in addition to Scenario Studio, and this
// feature's scope is Scenario Studio only. `stepLoansOneMonth` below is intentionally
// re-implemented (not imported) for the same reason simulator.engine.ts's own
// affordability.util.ts re-derives `calculateEmi` instead of importing across module
// boundaries — small, localized duplication over reaching into a file this feature
// doesn't own, matching an existing precedent in this codebase.

export interface StochasticLoanInput extends ScenarioLoanSnapshotDTO {}

export interface MonteCarloAssumptions {
  annualReturnMeanPercent: number;
  annualReturnStdDevPercent: number;
  expenseInflationMeanPercent: number;
  expenseInflationStdDevPercent: number;
  incomeGrowthMeanPercent: number;
  incomeGrowthStdDevPercent: number;
  propertyAppreciationMeanPercent: number;
  propertyAppreciationStdDevPercent: number;
}

export interface MonteCarloScenarioEffect {
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyInvestmentContribution: number;
  investmentsValue: number;
  loans: StochasticLoanInput[];
  immediateNetWorthDelta: number;
  // Only set for HOUSE_PURCHASE — the purchased property's value, grown at the
  // sampled propertyAppreciation rate each year and counted as an asset. Every other
  // scenario type leaves this undefined and no property-appreciation sampling happens
  // for them at all (matches simulator.engine.ts's explicit choice not to model
  // property as an asset outside this one case — see that file's HOUSE_PURCHASE
  // comment — except the probabilistic model DOES track it here, since "what's this
  // property likely worth under uncertainty" is exactly what Monte Carlo is for).
  propertyValue?: number;
}

export interface MonteCarloInput {
  scenarioType: ScenarioType;
  horizonMonths: number;
  iterations: number;
  seed: number;
  assumptions: MonteCarloAssumptions;
  effect: MonteCarloScenarioEffect;
}

export interface PercentileSet {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface YearlyBand extends PercentileSet {
  monthIndex: number; // 1-based
}

export interface MonteCarloRawResult {
  terminalNetWorths: number[];
  yearlyBands: YearlyBand[];
}

// --- Seeded PRNG (mulberry32) --------------------------------------------------------
// A seeded PRNG, never Math.random(), so a given seed always reproduces the same
// distribution — required for this module to stay unit-testable and for a given
// scenario run to be reproducible/debuggable rather than silently different every call.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller transform — converts two uniform [0,1) samples into one standard-normal
// sample. Bounds/clipping happen in sampleNormal() below, not here, since the
// plausible range is scenario/variable-specific (return rates vs. inflation vs. income
// growth all have different real-world bounds).
function standardNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function sampleNormal(
  rng: () => number,
  meanPercent: number,
  stdDevPercent: number,
  minPercent: number,
  maxPercent: number,
): number {
  if (stdDevPercent <= 0) return Math.min(maxPercent, Math.max(minPercent, meanPercent));
  const sample = meanPercent + standardNormal(rng) * stdDevPercent;
  return Math.min(maxPercent, Math.max(minPercent, sample));
}

// Linear-interpolation percentile over a SORTED ASCENDING array — the standard "R
// type 7" method (matches numpy's and pandas' default), chosen deliberately for
// consistency with any future cross-checking against a Python/analytics pipeline.
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  if (sortedAscending.length === 1) return sortedAscending[0];
  const rank = (p / 100) * (sortedAscending.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAscending[lower];
  const weight = rank - lower;
  return sortedAscending[lower] * (1 - weight) + sortedAscending[upper] * weight;
}

export function computePercentileSet(values: number[]): PercentileSet {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
  };
}

// Mirrors simulator.engine.ts's stepLoansOneMonth exactly: EMI-constant,
// reducing-balance amortization; a loan whose EMI doesn't cover interest is held flat
// (the same "stuck schedule" safety branch as computeAmortizationSchedule() (common/finance-math)) rather
// than diverging into negative amortization. Mutates `balances` in place and returns
// total cash outflow across all loans this month.
function stepLoansOneMonth(balances: number[], loans: StochasticLoanInput[]): number {
  let totalOutflow = 0;
  for (let i = 0; i < loans.length; i++) {
    const balance = balances[i];
    if (balance <= 0) continue;

    const monthlyRate = loans[i].annualRatePercent / 12 / 100;
    const interest = balance * monthlyRate;
    let principalPaid = loans[i].emi - interest;

    if (principalPaid <= 0) {
      totalOutflow += loans[i].emi;
      continue;
    }

    if (principalPaid > balance) principalPaid = balance; // final, partial month
    balances[i] = balance - principalPaid;
    totalOutflow += principalPaid + interest;
  }
  return totalOutflow;
}

// Bounds applied when sampling — wide enough to cover real historical extremes (e.g. a
// -30%+ equity year, double-digit CPI in a bad year) but finite, so a single
// pathological sample can't produce a NaN/Infinity terminal value. Named constants,
// not magic numbers, so they're visible and tunable in one place, same philosophy as
// simulator.engine.ts's BASE_ASSUMPTIONS being stated explicitly rather than buried.
const RETURN_RATE_MIN_PERCENT = -35;
const RETURN_RATE_MAX_PERCENT = 40;
const INFLATION_MIN_PERCENT = -2;
const INFLATION_MAX_PERCENT = 25;
const INCOME_GROWTH_MIN_PERCENT = -20;
const INCOME_GROWTH_MAX_PERCENT = 30;
const PROPERTY_APPRECIATION_MIN_PERCENT = -15;
const PROPERTY_APPRECIATION_MAX_PERCENT = 25;

/**
 * Runs `iterations` independent trajectories over `horizonMonths`, resampling
 * annualReturn / expenseInflation / incomeGrowth / (propertyAppreciation, when
 * applicable) ONCE PER YEAR per trajectory — not once per whole run — so each
 * trajectory captures genuine sequence-of-returns risk (a bad early year compounds
 * differently than a bad late year), which is exactly the thing a single flat
 * assumption (what the deterministic engine already does) cannot represent.
 *
 * Within a year, the sampled annual rates are held constant month-to-month — a
 * reasonable simplification; modeling monthly rate autocorrelation/volatility
 * clustering is out of scope for a personal-finance planning tool. Loans amortize
 * month-by-month using the SAME real EMI/rate on every trajectory — loan terms
 * themselves are not stochastic in this model (a fixed-rate Indian home/personal loan
 * doesn't re-price on a Monte Carlo draw the way a floating-rate instrument might; a
 * future iteration could add rate-reset stochasticity for floating-rate loans
 * specifically, but that's not modeled today — documented here rather than silently
 * assumed).
 */
export function runMonteCarloSimulation(input: MonteCarloInput): MonteCarloRawResult {
  const { horizonMonths, iterations, seed, assumptions, effect } = input;
  const horizonYears = Math.ceil(horizonMonths / 12);

  // Band cadence: reporting every month would be far more points than any chart needs
  // — quarterly for horizons up to 5 years, yearly beyond that. The terminal
  // distribution (percentiles below) always reflects the FULL horizon regardless of
  // this cadence; only the intermediate "fan chart" points are subsampled.
  const bandStepMonths = horizonMonths <= 60 ? 3 : 12;
  const bandMonthIndices = new Set<number>();
  for (let m = bandStepMonths - 1; m < horizonMonths; m += bandStepMonths) bandMonthIndices.add(m);
  bandMonthIndices.add(horizonMonths - 1); // always include the final month

  const monthlySamples = new Map<number, number[]>();
  for (const m of bandMonthIndices) monthlySamples.set(m, []);

  const terminalNetWorths: number[] = new Array(iterations);

  for (let iter = 0; iter < iterations; iter++) {
    // A distinct, deterministic RNG stream per iteration — 7919 is prime, chosen only
    // to avoid trivial seed collisions between adjacent iterations, not for any
    // cryptographic property (this PRNG is not cryptographically secure and must
    // never be used for anything security-sensitive).
    const rng = mulberry32(seed + iter * 7919);
    const balances = effect.loans.map((l) => l.principal);
    let investmentBalance = effect.investmentsValue;
    let idleCash = 0;
    let propertyValue = effect.propertyValue ?? 0;
    const trackProperty = effect.propertyValue !== undefined;

    let month = 0;
    for (let year = 0; year < horizonYears; year++) {
      const annualReturn = sampleNormal(
        rng,
        assumptions.annualReturnMeanPercent,
        assumptions.annualReturnStdDevPercent,
        RETURN_RATE_MIN_PERCENT,
        RETURN_RATE_MAX_PERCENT,
      );
      const inflation = sampleNormal(
        rng,
        assumptions.expenseInflationMeanPercent,
        assumptions.expenseInflationStdDevPercent,
        INFLATION_MIN_PERCENT,
        INFLATION_MAX_PERCENT,
      );
      const incomeGrowth = sampleNormal(
        rng,
        assumptions.incomeGrowthMeanPercent,
        assumptions.incomeGrowthStdDevPercent,
        INCOME_GROWTH_MIN_PERCENT,
        INCOME_GROWTH_MAX_PERCENT,
      );
      const propertyAppreciation = trackProperty
        ? sampleNormal(
            rng,
            assumptions.propertyAppreciationMeanPercent,
            assumptions.propertyAppreciationStdDevPercent,
            PROPERTY_APPRECIATION_MIN_PERCENT,
            PROPERTY_APPRECIATION_MAX_PERCENT,
          )
        : 0;

      const monthlyReturnRate = annualReturn / 12 / 100;
      const monthlyInflationRate = inflation / 12 / 100;
      const monthlyIncomeGrowthRate = incomeGrowth / 12 / 100;
      const monthlyPropertyRate = propertyAppreciation / 12 / 100;

      const monthsThisYear = Math.min(12, horizonMonths - month);
      for (let m = 0; m < monthsThisYear; m++) {
        const grownIncome = effect.monthlyIncome * Math.pow(1 + monthlyIncomeGrowthRate, month);
        const inflatedExpenses = effect.monthlyExpenses * Math.pow(1 + monthlyInflationRate, month);
        const emiOutflow = stepLoansOneMonth(balances, effect.loans);
        const cashSurplus = grownIncome - inflatedExpenses - effect.monthlyInvestmentContribution - emiOutflow;
        idleCash += cashSurplus;
        investmentBalance = investmentBalance * (1 + monthlyReturnRate) + effect.monthlyInvestmentContribution;
        if (trackProperty) propertyValue = propertyValue * (1 + monthlyPropertyRate);

        if (bandMonthIndices.has(month)) {
          const remainingLoanDebt = balances.reduce((sum, b) => sum + Math.max(0, b), 0);
          const netWorthAtMonth = idleCash + investmentBalance + propertyValue - remainingLoanDebt + effect.immediateNetWorthDelta;
          monthlySamples.get(month)!.push(netWorthAtMonth);
        }
        month++;
      }
    }

    const remainingLoanDebt = balances.reduce((sum, b) => sum + Math.max(0, b), 0);
    terminalNetWorths[iter] = idleCash + investmentBalance + propertyValue - remainingLoanDebt + effect.immediateNetWorthDelta;
  }

  const yearlyBands: YearlyBand[] = [...bandMonthIndices]
    .sort((a, b) => a - b)
    .map((m) => ({ monthIndex: m + 1, ...computePercentileSet(monthlySamples.get(m)!) }));

  return { terminalNetWorths, yearlyBands };
}
