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
// deterministic engine (simulator.engine.ts) does not model expense inflation at all —
// see README "Phase 13" for why this is the honest substitute rather than a fabricated
// inflation calculation with no real backing in the engine.
export const RETURN_RATE_SENSITIVITY_PERCENTS = [6, 8, 10, 12, 14] as const;

// LOAN_PREPAYMENT's "constrained" variant caps the lump sum against this fraction of
// the user's current investment value — a documented, deliberately simple guardrail
// ("don't suggest liquidating most of your portfolio to prepay a loan"), not a real
// liquidity/cash-availability calculation (this app doesn't model which specific
// assets are liquid).
export const MAX_PREPAYMENT_FRACTION_OF_INVESTMENTS = 0.1;
