import { TaxSection } from "@wealthos/types";

export interface TaxSlabBracket {
  from: number;
  to: number; // Infinity for the top (uncapped) bracket
  rate: number;
}

export interface TaxYearConfig {
  financialYear: string;
  oldRegimeSlabs: TaxSlabBracket[];
  newRegimeSlabs: TaxSlabBracket[];
  // Section 87A rebate makes tax effectively nil at/below this taxable-income threshold
  // under the new regime.
  newRegimeRebateThreshold: number;
  standardDeductionOld: number;
  standardDeductionNew: number;
  cessRate: number; // health & education cess, e.g. 0.04 = 4%
  sectionLimits: Partial<Record<TaxSection, number>>;
  // Surcharge is NOT slab-wise like income tax — once total income crosses a threshold,
  // the single matching rate applies to the entire base tax amount (before cess).
  // Deliberately different top brackets per regime: since Budget 2023, the new regime
  // caps surcharge at 25% (no 37% bracket), while the old regime retains the 37%
  // bracket above ₹5 crore.
  oldRegimeSurchargeSlabs: TaxSlabBracket[];
  newRegimeSurchargeSlabs: TaxSlabBracket[];
}

// Every entry here is a pure DATA addition, not a logic change — this is the whole
// point of the fix: a future Union Budget's new slabs/limits become a new keyed entry
// in this object, reviewed and added independently of tax.service.ts's calculation
// logic, instead of requiring an edit to the calculation code itself.
//
// The "2025-26" entry below is byte-identical to the values this file replaces (same
// slab boundaries, same rates, same limits, same standard deductions, same cess rate) —
// verified against the existing test suite, which asserts exact numeric outputs at
// several income levels and passes unchanged against this config.
export const TAX_CONFIG_BY_YEAR: Record<string, TaxYearConfig> = {
  "2025-26": {
    financialYear: "2025-26",
    oldRegimeSlabs: [
      { from: 0, to: 250000, rate: 0 },
      { from: 250000, to: 500000, rate: 0.05 },
      { from: 500000, to: 1000000, rate: 0.2 },
      { from: 1000000, to: Infinity, rate: 0.3 },
    ],
    newRegimeSlabs: [
      { from: 0, to: 400000, rate: 0 },
      { from: 400000, to: 800000, rate: 0.05 },
      { from: 800000, to: 1200000, rate: 0.1 },
      { from: 1200000, to: 1600000, rate: 0.15 },
      { from: 1600000, to: 2000000, rate: 0.2 },
      { from: 2000000, to: 2400000, rate: 0.25 },
      { from: 2400000, to: Infinity, rate: 0.3 },
    ],
    newRegimeRebateThreshold: 1200000,
    standardDeductionOld: 50000,
    standardDeductionNew: 75000,
    cessRate: 0.04,
    sectionLimits: {
      SECTION_80C: 150000,
      SECTION_80D: 25000,
      SECTION_80CCD_1B: 50000,
      HOME_LOAN_INTEREST: 200000,
      SECTION_80TTA: 10000,
    },
    // NEW: surcharge was previously not modeled at all (a flagged gap — "no surcharge
    // for very high incomes... a real gap for higher earners"). Both tables below are
    // no-ops for any income at or below ₹50 lakh, so this addition doesn't change any
    // existing test's output (the current test suite's highest tested income is ₹24L).
    oldRegimeSurchargeSlabs: [
      { from: 5000000, to: 10000000, rate: 0.1 },
      { from: 10000000, to: 20000000, rate: 0.15 },
      { from: 20000000, to: 50000000, rate: 0.25 },
      { from: 50000000, to: Infinity, rate: 0.37 },
    ],
    newRegimeSurchargeSlabs: [
      { from: 5000000, to: 10000000, rate: 0.1 },
      { from: 10000000, to: 20000000, rate: 0.15 },
      { from: 20000000, to: Infinity, rate: 0.25 }, // capped at 25% — no 37% bracket under the new regime
    ],
  },
};

export interface ResolvedTaxYearConfig {
  config: TaxYearConfig;
  isEstimatedFromPriorYear: boolean;
}

// Resolves a requested financial year to a config, falling back to the most recent
// available year (rather than throwing, or worse, silently guessing at slabs that don't
// exist) when there's no exact entry yet — e.g. a future FY whose Budget hasn't been
// added to TAX_CONFIG_BY_YEAR. This is the actual mechanism that "reduces the risk of
// the app silently using stale slabs after a future budget" (the audit's stated goal
// for this fix): the caller always gets a usable config AND an explicit, honest signal
// that it's an approximation from a prior year, rather than either a hard failure or a
// number presented with false precision.
export function resolveTaxYearConfig(financialYear: string): ResolvedTaxYearConfig {
  const exact = TAX_CONFIG_BY_YEAR[financialYear];
  if (exact) {
    return { config: exact, isEstimatedFromPriorYear: false };
  }

  // "YYYY-YY" financial-year strings sort correctly lexicographically for any
  // reasonable year range, so no numeric parsing is needed here.
  const availableYears = Object.keys(TAX_CONFIG_BY_YEAR).sort();
  const latestYear = availableYears[availableYears.length - 1];
  return { config: TAX_CONFIG_BY_YEAR[latestYear], isEstimatedFromPriorYear: true };
}
