// PURE MODULE — no Prisma, no I/O. Classifies a realized gain/loss into the correct
// Indian capital-gains category based on investment type and holding period, and
// computes the tax on a summarized set of gains.
//
// Audit item #11: "Investments are not connected to capital-gains tax calculations."
// This is genuinely fiddly, real-money tax law — every simplification below is
// explicit and disclosed, following this codebase's own established precedent
// (tax.service.ts's own marginal-relief and capital-gains omissions were previously
// left unimplemented and disclosed rather than risk getting them subtly wrong; this
// file is the capital-gains half of closing that gap, with the same care).
//
// RULES IMPLEMENTED (as of FY2025-26, post the July 2024 Budget changes):
//   - Equity-oriented (STOCK, ETF, MUTUAL_FUND — see the disclosed MUTUAL_FUND
//     simplification below): 12-month long-term threshold. STCG flat 20%. LTCG flat
//     12.5%, with a ₹1,25,000/year exemption (only the excess above that is taxed).
//   - CRYPTO: flat 30% on gains regardless of holding period (no ST/LT distinction —
//     this is correct, not a simplification: Indian crypto tax law has never had one).
//     Losses cannot offset gains from crypto or anything else (also a real rule, not
//     a simplification) — disclosed separately as "disallowed loss," never subtracted.
//   - Everything else taxed as a capital asset (GOLD, SILVER, REAL_ESTATE, BOND,
//     BUSINESS_EQUITY, OTHER): 24-month long-term threshold. LTCG flat 12.5%, no
//     exemption. STCG is added to total taxable income and taxed at the marginal slab
//     rate (a real rule, not a simplification — computed via applySlabs(), see
//     TaxService.capitalGainsSummary()).
//   - EPF, PPF, NPS, FD are explicitly EXCLUDED from capital-gains treatment
//     entirely — EPF/PPF/NPS maturity proceeds are tax-exempt (EEE status) under
//     normal circumstances, and FD "gains" are interest income, already taxed as
//     regular income elsewhere, not a capital gain from a sale. Attempting to record
//     a realized-gain event against one of these types is rejected outright (see
//     InvestmentsService.recordSale()), not silently miscategorized.
//
// DISCLOSED SIMPLIFICATIONS:
//   1. MUTUAL_FUND is treated as equity-oriented for ALL funds, not just
//      equity/hybrid-equity schemes — debt mutual funds are taxed differently (as
//      short-term regardless of holding period, since an April 2023 rule change).
//      This app doesn't track a fund's underlying asset allocation, so there's no
//      reliable signal to distinguish them; this is disclosed via
//      CapitalGainsSummaryDTO.isProjectionOnly and this comment, matching exactly how
//      TaxService already discloses its own unimplemented pieces.
//   2. Other-asset STCG's marginal tax rate is computed against the OLD REGIME's
//      taxable income baseline only, not separately for both regimes — see
//      TaxService.capitalGainsSummary() for why.

import { InvestmentType } from "@wealthos/db";

export type CapitalGainsCategory =
  | "EQUITY_SHORT_TERM"
  | "EQUITY_LONG_TERM"
  | "CRYPTO"
  | "OTHER_SHORT_TERM"
  | "OTHER_LONG_TERM";

const EQUITY_LIKE_TYPES: InvestmentType[] = ["STOCK", "ETF", "MUTUAL_FUND"];
// EPF/PPF/NPS/FD are deliberately absent from every set below — see the doc comment
// above. classifyGainCategory() throws for these rather than silently guessing.
const EXCLUDED_TYPES: InvestmentType[] = ["EPF", "PPF", "NPS", "FD"];

const EQUITY_LONG_TERM_THRESHOLD_DAYS = 365; // 12 months
const OTHER_ASSET_LONG_TERM_THRESHOLD_DAYS = 730; // 24 months

export const EQUITY_LTCG_ANNUAL_EXEMPTION = 125000; // ₹1,25,000/year, equity LTCG only
export const EQUITY_STCG_RATE = 0.2;
export const EQUITY_LTCG_RATE = 0.125;
export const CRYPTO_TAX_RATE = 0.3;
export const OTHER_LTCG_RATE = 0.125;

export class CapitalGainsExcludedTypeError extends Error {
  constructor(type: InvestmentType) {
    super(
      `${type} is not subject to capital-gains tax in this model — EPF/PPF/NPS maturity proceeds are tax-exempt, and FD "gains" are interest income taxed as regular income, not a capital gain from a sale.`,
    );
    this.name = "CapitalGainsExcludedTypeError";
  }
}

// Classifies a single realized sale into the correct capital-gains category, given
// the investment's type and how many days it was held (saleDate - purchaseDate).
// Throws CapitalGainsExcludedTypeError for EPF/PPF/NPS/FD — callers must not attempt
// to record a realized-gain event for these types at all.
export function classifyGainCategory(investmentType: InvestmentType, holdingPeriodDays: number): CapitalGainsCategory {
  if (EXCLUDED_TYPES.includes(investmentType)) {
    throw new CapitalGainsExcludedTypeError(investmentType);
  }
  if (investmentType === "CRYPTO") {
    return "CRYPTO";
  }
  if (EQUITY_LIKE_TYPES.includes(investmentType)) {
    return holdingPeriodDays > EQUITY_LONG_TERM_THRESHOLD_DAYS ? "EQUITY_LONG_TERM" : "EQUITY_SHORT_TERM";
  }
  return holdingPeriodDays > OTHER_ASSET_LONG_TERM_THRESHOLD_DAYS ? "OTHER_LONG_TERM" : "OTHER_SHORT_TERM";
}

export interface RealizedGainInput {
  category: CapitalGainsCategory;
  gainAmount: number; // proceeds - costBasisPortion; negative means a loss
}

export interface CapitalGainsTaxBreakdown {
  equityShortTermGain: number;
  equityLongTermGain: number;
  equityLongTermExemptionUsed: number;
  cryptoGain: number; // only positive gains — see cryptoLossDisallowed below
  cryptoLossDisallowed: number; // sum of crypto losses, which cannot offset anything
  otherShortTermGain: number;
  otherLongTermGain: number;
  equityShortTermTax: number;
  equityLongTermTax: number;
  cryptoTax: number;
  otherLongTermTax: number;
  // otherShortTermTax is deliberately NOT computed here — it depends on the person's
  // total taxable income (marginal slab rate), which this pure function has no
  // knowledge of. TaxService.capitalGainsSummary() computes it separately via
  // applySlabs() and merges it into the final DTO.
}

// Aggregates a set of realized-gain events into the category-level totals
// TaxService.capitalGainsSummary() needs. Deliberately pure and side-effect-free — no
// database access, so this is fully unit-testable in isolation from Prisma.
export function summarizeCapitalGains(events: RealizedGainInput[]): CapitalGainsTaxBreakdown {
  let equityShortTermGain = 0;
  let equityLongTermGain = 0;
  let cryptoGain = 0;
  let cryptoLossDisallowed = 0;
  let otherShortTermGain = 0;
  let otherLongTermGain = 0;

  for (const event of events) {
    switch (event.category) {
      case "EQUITY_SHORT_TERM":
        // Losses DO offset gains within the same category — a real rule, not a
        // simplification. Summing signed amounts achieves this automatically.
        equityShortTermGain += event.gainAmount;
        break;
      case "EQUITY_LONG_TERM":
        equityLongTermGain += event.gainAmount;
        break;
      case "CRYPTO":
        // Crypto losses cannot offset ANYTHING — not even other crypto gains. Only
        // positive events contribute to cryptoGain; negative ones are tracked
        // separately as a disclosed, un-actionable figure.
        if (event.gainAmount > 0) {
          cryptoGain += event.gainAmount;
        } else {
          cryptoLossDisallowed += Math.abs(event.gainAmount);
        }
        break;
      case "OTHER_SHORT_TERM":
        otherShortTermGain += event.gainAmount;
        break;
      case "OTHER_LONG_TERM":
        otherLongTermGain += event.gainAmount;
        break;
    }
  }

  // Losses can drag a category's net total below zero (e.g. more equity LT losses
  // than gains this year) — clamped at 0 for tax purposes (a net loss owes no tax;
  // carrying it forward to offset future years' gains is a real provision but out of
  // scope here, since this app has no concept of "financial year N-1's carried-forward
  // loss" to draw from).
  const positiveEquityShortTermGain = Math.max(0, equityShortTermGain);
  const positiveEquityLongTermGain = Math.max(0, equityLongTermGain);
  const positiveOtherLongTermGain = Math.max(0, otherLongTermGain);

  const equityLongTermExemptionUsed = Math.min(positiveEquityLongTermGain, EQUITY_LTCG_ANNUAL_EXEMPTION);
  const taxableEquityLongTermGain = Math.max(0, positiveEquityLongTermGain - EQUITY_LTCG_ANNUAL_EXEMPTION);

  return {
    equityShortTermGain,
    equityLongTermGain,
    equityLongTermExemptionUsed,
    cryptoGain,
    cryptoLossDisallowed,
    otherShortTermGain,
    otherLongTermGain,
    equityShortTermTax: positiveEquityShortTermGain * EQUITY_STCG_RATE,
    equityLongTermTax: taxableEquityLongTermGain * EQUITY_LTCG_RATE,
    cryptoTax: cryptoGain * CRYPTO_TAX_RATE,
    otherLongTermTax: positiveOtherLongTermGain * OTHER_LTCG_RATE,
  };
}
