import { ScenarioType } from "@wealthos/types";

export type VariantLabel = "best" | "base" | "worst" | "constrained";
export const VARIANT_LABELS: VariantLabel[] = ["best", "base", "worst", "constrained"];

export interface FieldConfig {
  /** The single numeric field this scenario type's variants/sensitivity sweep vary.
   * Every ScenarioType here has exactly one — scenarios with multiple numeric fields
   * (HOUSE_PURCHASE has four) still only vary the one that most determines the
   * outcome; the others stay at the user's literal input across all variants. This is
   * a deliberate scope limit, not an oversight — see README "Phase 13". */
  field: string;
  /** "optimistic": increasing this field makes the outcome better (e.g. a bigger
   * salary hike). "pessimistic": increasing it makes the outcome worse (e.g. a bigger
   * emergency expense). Drives which multiplier the best/worst variants get. */
  direction: "optimistic" | "pessimistic";
  /** Whether this field represents money the user would need to actually commit
   * (an ongoing SIP amount, a lump-sum prepayment, an EMI-driving purchase price) —
   * only these get a real affordability-capped "constrained" variant; the rest use
   * the base value for "constrained" since there's no discretionary spend to cap. */
  isDiscretionarySpend: boolean;
  /** RETIREMENT_AGE_SHIFT's field is an absolute age, not a magnitude — multiplying an
   * age by 1.5 is meaningless, so it gets hand-written variant logic in
   * ScenarioExpanderService instead of the generic multiplier path. */
  isAge?: boolean;
}

export const SCENARIO_FIELD_CONFIG: Record<ScenarioType, FieldConfig> = {
  SALARY_HIKE: { field: "percentIncrease", direction: "optimistic", isDiscretionarySpend: false },
  SALARY_DROP: { field: "percentDecrease", direction: "pessimistic", isDiscretionarySpend: false },
  SIP_INCREASE: { field: "additionalMonthlyAmount", direction: "optimistic", isDiscretionarySpend: true },
  SIP_DECREASE: { field: "reducedMonthlyAmount", direction: "pessimistic", isDiscretionarySpend: false },
  HOUSE_PURCHASE: { field: "propertyValue", direction: "pessimistic", isDiscretionarySpend: true },
  LOAN_PREPAYMENT: { field: "lumpSum", direction: "optimistic", isDiscretionarySpend: true },
  RETIREMENT_AGE_SHIFT: { field: "newRetirementAge", direction: "optimistic", isDiscretionarySpend: false, isAge: true },
  EMERGENCY_EXPENSE: { field: "amount", direction: "pessimistic", isDiscretionarySpend: false },
  GOAL_DELAY: { field: "delayMonths", direction: "pessimistic", isDiscretionarySpend: false },
};

// best/worst multipliers applied to the primary field's magnitude, direction-aware —
// an "optimistic" field gets the larger multiplier in the best case and the smaller
// one in the worst case; a "pessimistic" field is the mirror image. base is always the
// user's literal input (multiplier 1). These are named, tunable constants rather than
// scattered numbers, and deliberately modest (not 10x swings) so variants stay in a
// plausible range of the user's own input rather than becoming absurd.
export const VARIANT_MULTIPLIERS = { best: 1.5, base: 1, worst: 0.5 } as const;

// Multipliers used for the sensitivity sweep (a wider spread than best/worst variants,
// since sensitivity analysis is meant to show the shape of the outcome across a range,
// not just three named scenarios).
export const SENSITIVITY_MULTIPLIERS = [0.5, 0.75, 1, 1.25, 1.5] as const;

// Age deltas (in years) used for RETIREMENT_AGE_SHIFT's sensitivity sweep and variant
// generation, since a multiplier doesn't make sense applied to an absolute age.
export const AGE_SENSITIVITY_DELTAS = [-5, -2, 0, 2, 5] as const;

// Assumed annual investment return rates used for the "return-rate sensitivity" sweep
// that stands in for the roadmap's requested "inflation changes" dimension. The
// deterministic engine (simulator.engine.ts) models expense inflation as a fixed
// assumption (DEFAULT_ANNUAL_EXPENSE_INFLATION_PERCENT), not something callers can vary
// per-run — so a genuine "inflation sensitivity" sweep still isn't meaningful to offer;
// this return-rate sweep remains the honest, closest-available substitute (see README
// "Phase 13").
export const RETURN_RATE_SENSITIVITY_PERCENTS = [6, 8, 10, 12, 14] as const;

// Mirrors simulator.engine.ts's DEFAULT_ANNUAL_EXPENSE_INFLATION_PERCENT exactly, kept
// as its own small constant here (rather than importing it) since sensitivity-analysis
// .service.ts calls the engine's exported projectNetWorth() directly rather than going
// through runScenario()/SimulatorService, so it must supply the same inflation
// assumption itself to keep its baseline point consistent with every other number
// Scenario Studio surfaces (which flow through the loans+inflation-aware engine path).
// If the Simulator's default ever changes, update this constant to match.
export const SENSITIVITY_EXPENSE_INFLATION_PERCENT = 6;

// LOAN_PREPAYMENT's "constrained" variant caps the lump sum against this fraction of
// the user's actual LIQUID investment value (Investment.liquidity === "LIQUID" —
// excludes SEMI_LIQUID/ILLIQUID holdings like PPF/EPF/NPS that can't realistically be
// withdrawn to fund a lump-sum prepayment). Still a deliberately simple guardrail
// ("don't suggest liquidating most of your liquid portfolio to prepay a loan"), not a
// full cash-availability model (doesn't account for emergency-fund reservations, tax
// implications of liquidating, or exit loads/lock-in periods within the LIQUID bucket
// itself) — but it now uses real per-asset liquidity data the schema already tracks,
// rather than approximating against total investment value including locked-in assets.
export const MAX_PREPAYMENT_FRACTION_OF_LIQUID_INVESTMENTS = 0.1;

// --- Probabilistic planning (Monte Carlo) -------------------------------------------
// Iteration-count bounds. MIN keeps a caller-supplied override from producing a
// statistically meaningless distribution; MAX bounds worst-case latency for the
// dedicated /scenario-studio/simulate endpoint (each iteration is a small, cheap
// month-by-month loop, but 5,000 iterations x up to 600 months is still real CPU work
// on a request thread). DEFAULT is the fidelity used when a caller doesn't override.
export const MIN_MC_ITERATIONS = 200;
export const MAX_MC_ITERATIONS = 5000;
export const DEFAULT_MC_ITERATIONS = 2000;
// A lighter iteration count used only for the automatic Monte Carlo preview attached
// to ScenarioStudioService.build()'s ranked winner — build() already does up to ~10
// deterministic SimulatorService.run() calls plus 2 AI gateway calls (see
// ScenarioStudioController's rate-limit comment), so its MC preview is deliberately
// fast/approximate. Callers wanting full fidelity should call the dedicated
// POST /scenario-studio/simulate endpoint directly.
export const BUILD_MC_PREVIEW_ITERATIONS = 500;
// Same 600-month (50-year) safety cap LoansService.computeSchedule() already uses,
// applied here for the same reason: a guard against a pathological horizon (e.g. a
// RETIREMENT_AGE_SHIFT target decades away) making a single request loop forever.
export const MC_HORIZON_MONTHS_CAP = 600;

// Default distribution assumptions for each stochastic variable. Every mean here
// intentionally matches the corresponding deterministic constant in
// simulator.engine.ts (DEFAULT_ANNUAL_INVESTMENT_RETURN_PERCENT = 10,
// DEFAULT_ANNUAL_EXPENSE_INFLATION_PERCENT = 6) so the probabilistic median
// approximately re-derives the deterministic point estimate at low horizons, rather
// than silently diverging from the numbers Scenario Studio already shows elsewhere.
// Standard deviations are commonly-cited long-run figures for Indian broad-market
// index funds / CPI / wage growth / residential property — NOT fitted to any
// individual user's actual portfolio mix or career trajectory. That personalization
// is a real, documented future improvement, not silently claimed here.
export const DEFAULT_MC_ASSUMPTIONS = {
  annualReturnMeanPercent: 10,
  annualReturnStdDevPercent: 15,
  expenseInflationMeanPercent: 6,
  expenseInflationStdDevPercent: 2,
  incomeGrowthMeanPercent: 3,
  incomeGrowthStdDevPercent: 4,
  // India residential real estate long-run appreciation is historically lower and
  // more volatile than "property always goes up" folklore suggests — this default is
  // deliberately modest, not aspirational.
  propertyAppreciationMeanPercent: 5,
  propertyAppreciationStdDevPercent: 6,
} as const;

// Coefficient of variation (stddev / |mean| of the terminal net worth distribution)
// thresholds used to bucket a scenario's risk level for the UI. A single-number
// heuristic over the whole distribution, deliberately simple and tunable — same "state
// the model so it can be surfaced/tuned in one place" philosophy as
// simulator.engine.ts's BASE_ASSUMPTIONS array.
export const RISK_LEVEL_COV_THRESHOLDS = { low: 0.15, medium: 0.35 } as const;

// --- Optimization / constraint solver -----------------------------------------------
// Only scenario types with a single continuous (or integer) decision variable that
// meaningfully trades off against risk are optimizable today — SALARY_HIKE/DROP and
// EMERGENCY_EXPENSE describe things that happen TO the user, not a choice to optimize;
// HOUSE_PURCHASE has four interacting fields (property value, down payment %, rate,
// tenure), which a single-variable grid search can't responsibly recommend without a
// real multi-variable solver (a documented scope limit, not an oversight — see
// scenario-optimizer.service.ts).
export const OPTIMIZABLE_SCENARIO_TYPES: ScenarioType[] = [
  "SIP_INCREASE",
  "LOAN_PREPAYMENT",
  "RETIREMENT_AGE_SHIFT",
  "GOAL_DELAY",
];

// Two-pass grid search: a coarse pass across the full feasible range, then a fine pass
// refining around the coarse winner. This is a deliberately simple, dependency-free
// constrained search (no external LP/solver library) chosen so the optimizer stays as
// testable and deterministic as every other engine-layer file in this codebase — see
// scenario-optimizer.service.ts's top-of-file comment for why a full LP solver wasn't
// used. Works well here because every optimizable scenario type's objective (median
// terminal net worth minus a downside-risk penalty) is monotonic-ish / unimodal across
// its single decision variable, not because it's a general-purpose global optimizer.
export const OPTIMIZATION_COARSE_STEPS = 9;
export const OPTIMIZATION_FINE_STEPS = 7;
// Each grid point runs its own Monte Carlo simulation purely to rank candidates — a
// reduced iteration count keeps the search itself fast. The FINAL recommended
// parameter value is always re-run at full DEFAULT_MC_ITERATIONS fidelity before being
// returned, so the number actually shown to the user is never a search-time
// approximation (see ScenarioOptimizerService.optimize()).
export const OPTIMIZATION_SEARCH_ITERATIONS_PER_MC = 300;
// Weight on downside deviation (p50 - p10) in the risk-adjusted score:
// score = p50 - LAMBDA * (p50 - p10) - (feasible ? 0 : INFEASIBILITY_PENALTY).
// A named, tunable constant rather than a buried literal — 0.5 means "a rupee of
// downside risk is worth half a rupee of upside median" as a starting point; raising
// it favors more conservative recommendations.
export const OPTIMIZATION_RISK_AVERSION_LAMBDA = 0.5;
// Mirrors ScenarioRankingService's own INFEASIBILITY_PENALTY exactly — an infeasible
// candidate must never be able to outscore a feasible one, however good its raw
// median looks.
export const OPTIMIZATION_INFEASIBILITY_PENALTY = 1e12;
// Fraction of the user's real monthly surplus (income - expenses - existing EMIs) that
// the optimizer is allowed to commit to a new SIP/EMI by default, absent an explicit
// `maxMonthlyBudgetPercent` constraint — leaves a buffer rather than searching all the
// way up to 100% of surplus, which would recommend committing every spare rupee.
export const DEFAULT_MAX_BUDGET_FRACTION_OF_SURPLUS = 0.8;
