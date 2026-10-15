import { CoachRecommendationDTO } from "@wealthos/types";
import { formatINR } from "../../../common/utils/currency.util";
import { GoalAssessment, HIGH_INTEREST_RATE_PERCENT, EMI_TO_INCOME_CAUTION_RATIO, EmergencyVerdict } from "./coach-metrics";

// Deterministic recommendation generation and ranking. No model decides what matters most, and no model
// invents a weight: the order comes from the fixed tiers below, then from rupee impact, then from id.
//
// Tiers (lower runs first), each justified in the recommendation's own `priority.reason`:
//   1  Liquidity and safety   - negative cash flow, emergency fund below half of target
//   2  Debt cost and cover    - emergency fund partly short, expensive debt, heavy EMI load
//   3  Goals                  - overdue goals, goals behind pace, retirement gap
//   4  Optimisation           - insurance gaps against benchmarks, category spikes
//
// Safeguards applied here, not in prose: nothing that moves money into investments is recommended while
// emergency liquidity is low or monthly cash flow is negative; stated preferences remove a recommendation
// entirely and the removal is reported in `suppressed` so the user can see it was not forgotten.

export interface CoachPreferences {
  avoidDebtPrepayment: boolean;
  avoidInvestmentIncrease: boolean;
  protectEmergencyFund: boolean;
}

export const NO_PREFERENCES: CoachPreferences = { avoidDebtPrepayment: false, avoidInvestmentIncrease: false, protectEmergencyFund: false };

/** Reads standing constraints/preferences the user has stated. Keyword rules only; no model. */
export function derivePreferences(texts: string[]): CoachPreferences {
  const joined = texts.join(" \n ").toLowerCase();
  const negated = (subject: RegExp) => new RegExp(`(?:\\b(?:no|avoid|don'?t|do not|never|not)\\b[^.\\n]{0,40}${subject.source})|(?:${subject.source}[^.\\n]{0,40}\\b(?:off the table|is off limits|not allowed)\\b)`, "i").test(joined);
  return {
    avoidDebtPrepayment: negated(/\b(?:prepay|prepayment|pre-pay|pay(?:ing)? off (?:my )?(?:loan|debt))\b/),
    avoidInvestmentIncrease: negated(/\b(?:increas\w*|more|extra)\b[^.\n]{0,20}\b(?:sip|invest\w*)\b|\b(?:sip|invest\w*)\b[^.\n]{0,20}\b(?:increase|more)\b/),
    protectEmergencyFund: /\b(?:don'?t|do not|never|avoid)\b[^.\n]{0,30}\b(?:touch|use|spend|withdraw|break)\b[^.\n]{0,30}\bemergency\b/i.test(joined) || /\bprotect\b[^.\n]{0,20}\bemergency\b/i.test(joined),
  };
}

export interface RecLoan {
  id: string;
  lender: string;
  type: string;
  ratePercent: number;
  outstanding: number;
  emi: number;
}

export interface RecommendationFacts {
  /** Complete-month figures. Null means "not recorded", never zero. */
  monthlyIncome: number | null;
  monthlySpending: number | null;
  /** income - spending - EMIs for the last complete month; null when any input is missing. */
  monthlySurplus: number | null;
  emergency: { verdict: EmergencyVerdict; shortfall: number | null; coverageMonths: number | null; targetMonths: number | null; targetIsDefault: boolean };
  loans: RecLoan[];
  emiToIncome: number | null;
  goals: GoalAssessment[];
  retirement: { onTrack: boolean; corpusGap: number; requiredMonthlySip: number; yearsToRetirement: number } | null;
  insuranceGaps: { type: string; gap: number; hasCoverage: boolean }[];
  categoryIncreases: { name: string; monthlyIncrease: number; ratio: number | null }[];
  preferences: CoachPreferences;
}

export interface RankedRecommendations {
  recommendations: CoachRecommendationDTO[];
  /** Recommendations withheld because of a safeguard or a stated preference, with the reason. */
  suppressed: string[];
}

interface Candidate {
  tier: 1 | 2 | 3 | 4;
  annualImpact: number;
  rec: Omit<CoachRecommendationDTO, "rank">;
}

const TIER_REASON: Record<1 | 2 | 3 | 4, string> = {
  1: "Liquidity and safety come first: a shortfall here makes every other decision riskier.",
  2: "Debt cost and emergency cover come before growth: they are guaranteed costs or gaps.",
  3: "Goals are ranked after safety and debt, by the rupee shortfall involved.",
  4: "Optimisation comes last; it improves an already stable position.",
};

function priorityLevel(tier: 1 | 2 | 3 | 4): "urgent" | "high" | "medium" | "low" {
  return tier === 1 ? "urgent" : tier === 2 ? "high" : tier === 3 ? "medium" : "low";
}

function feasibility(neededMonthly: number | null, surplus: number | null): string {
  if (neededMonthly === null) return "Not a monthly commitment.";
  if (surplus === null) return "Cannot be checked: income, spending or EMIs for the last complete month are not fully recorded.";
  if (surplus <= 0) return `Not feasible from current cash flow: the last complete month had no surplus after spending and EMIs (${formatINR(surplus)}).`;
  if (neededMonthly <= surplus) return `Fits within your last complete month's surplus of ${formatINR(surplus)} (needs ${formatINR(neededMonthly)} a month).`;
  return `Exceeds your last complete month's surplus of ${formatINR(surplus)} by ${formatINR(neededMonthly - surplus)} a month; it would need to be phased or the target date moved.`;
}

const ROUTES = {
  emergency: { label: "Open Emergency Fund", href: "/money/emergency-fund" },
  loans: { label: "Open Loans", href: "/money/loans" },
  goals: { label: "Open Goals", href: "/goals" },
  retirement: { label: "Open Retirement", href: "/money/retirement" },
  insurance: { label: "Open Insurance", href: "/protect" },
  expenses: { label: "Open Expenses", href: "/money/expenses" },
  investments: { label: "Open Investments", href: "/money/investments" },
} as const;

/** Builds, filters and ranks recommendations. Pure and deterministic: same facts in, same list out. */
export function buildRecommendations(f: RecommendationFacts, maxItems = 5): RankedRecommendations {
  const candidates: Candidate[] = [];
  const suppressed: string[] = [];
  const cashFlowNegative = f.monthlySurplus !== null && f.monthlySurplus < 0;
  const emergencyLow = f.emergency.verdict === "low";
  // Anything that moves money into investments or locks cash is held back while liquidity is at risk.
  const liquidityAtRisk = cashFlowNegative || emergencyLow;

  // Tier 1: cash flow.
  if (cashFlowNegative && f.monthlyIncome !== null && f.monthlySpending !== null) {
    const deficit = Math.abs(f.monthlySurplus!);
    candidates.push({
      tier: 1,
      annualImpact: deficit * 12,
      rec: {
        id: "cash-flow-deficit",
        title: "Close the monthly cash-flow gap",
        issue: `In the last complete month, income (${formatINR(f.monthlyIncome)}) did not cover spending (${formatINR(f.monthlySpending)}) plus EMIs: a gap of ${formatINR(deficit)}.`,
        evidence: [`Income ${formatINR(f.monthlyIncome)}`, `Spending ${formatINR(f.monthlySpending)}`, `Gap ${formatINR(deficit)}`],
        whyItMatters: "A recurring gap is funded from savings or debt, which erodes everything else in the plan.",
        nextStep: "Review the largest categories and recurring charges first, and decide which to reduce to recover this amount each month.",
        estimatedImpact: { display: `${formatINR(deficit * 12)} a year`, formula: "monthly gap x 12" },
        priority: { level: "urgent", reason: TIER_REASON[1] },
        feasibility: "This is the constraint the other recommendations depend on.",
        tradeoffs: ["Cutting spending reduces lifestyle flexibility; raising income takes longer but does not."],
        missingInfo: ["Whether the last month was typical (one-off spending would overstate the gap)."],
        destination: ROUTES.expenses,
      },
    });
  }

  // Tier 1/2: emergency fund.
  if ((f.emergency.verdict === "low" || f.emergency.verdict === "partial") && f.emergency.shortfall !== null && f.emergency.shortfall > 0) {
    const tier: 1 | 2 = emergencyLow ? 1 : 2;
    const monthly = f.emergency.shortfall / 12;
    candidates.push({
      tier,
      annualImpact: f.emergency.shortfall,
      rec: {
        id: "emergency-fund-top-up",
        title: "Top up your emergency fund",
        issue: `Your emergency cash covers ${f.emergency.coverageMonths === null ? "an unknown number of" : f.emergency.coverageMonths.toFixed(1)} months of essential expenses against a ${f.emergency.targetMonths === null ? "" : f.emergency.targetMonths.toFixed(0) + "-month "}target${f.emergency.targetIsDefault ? " (a common default; you have not set your own)" : ""}.`,
        evidence: [`Shortfall ${formatINR(f.emergency.shortfall)}`, ...(f.emergency.coverageMonths !== null ? [`Coverage ${f.emergency.coverageMonths.toFixed(1)} months`] : [])],
        whyItMatters: "Without a buffer, an income gap or a large bill is paid for with debt or by selling investments at a bad time.",
        nextStep: `Direct about ${formatINR(monthly)} a month to the reserve to close the gap in 12 months (a planning horizon you can change).`,
        estimatedImpact: { display: `Closes ${formatINR(f.emergency.shortfall)} of shortfall`, formula: "target amount - current emergency cash" },
        priority: { level: priorityLevel(tier), reason: TIER_REASON[tier] },
        feasibility: feasibility(monthly, f.monthlySurplus),
        tradeoffs: ["Money moved to the reserve is not available for investing or prepaying debt in the meantime."],
        missingInfo: f.emergency.targetIsDefault ? ["Your own emergency-fund target; set one on the Emergency Fund page to replace the default."] : [],
        destination: ROUTES.emergency,
      },
    });
  }

  // Tier 2: expensive debt.
  const expensive = [...f.loans].filter((l) => l.ratePercent >= HIGH_INTEREST_RATE_PERCENT).sort((a, b) => b.ratePercent - a.ratePercent)[0];
  if (expensive) {
    if (f.preferences.avoidDebtPrepayment) {
      suppressed.push(`Prepaying the ${expensive.lender} loan was not suggested because you asked to avoid prepaying debt.`);
    } else if (liquidityAtRisk) {
      suppressed.push(`Prepaying the ${expensive.lender} loan (${expensive.ratePercent}%) was held back until cash flow and the emergency fund are secure.`);
    } else {
      const annualInterest = (expensive.outstanding * expensive.ratePercent) / 100;
      candidates.push({
        tier: 2,
        annualImpact: annualInterest,
        rec: {
          id: `prepay-${expensive.id}`,
          title: `Prioritise the ${expensive.lender} ${expensive.type.toLowerCase().replace(/_/g, " ")} loan`,
          issue: `This loan charges ${expensive.ratePercent}% a year on ${formatINR(expensive.outstanding)} outstanding.`,
          evidence: [`Rate ${expensive.ratePercent}%`, `Outstanding ${formatINR(expensive.outstanding)}`, `EMI ${formatINR(expensive.emi)}`],
          whyItMatters: "Paying down expensive debt is a guaranteed return equal to the interest rate; no investment can promise that.",
          nextStep: "Put surplus cash toward this loan before increasing investments, and check the lender's prepayment charges first.",
          estimatedImpact: { display: `About ${formatINR(annualInterest)} a year in interest at the current balance`, formula: "outstanding principal x annual rate (first-year approximation, before amortisation)" },
          priority: { level: "high", reason: TIER_REASON[2] },
          feasibility: f.monthlySurplus !== null && f.monthlySurplus > 0 ? `Your last complete month's surplus was ${formatINR(f.monthlySurplus)}.` : "Surplus could not be determined.",
          tradeoffs: ["Cash used to prepay is no longer liquid.", "Prepayment may carry fees or reduce tax deductions on interest."],
          missingInfo: ["Prepayment charges and whether the loan is fixed or floating."],
          destination: ROUTES.loans,
        },
      });
    }
  }

  // Tier 2: EMI load.
  if (f.emiToIncome !== null && f.emiToIncome > EMI_TO_INCOME_CAUTION_RATIO) {
    candidates.push({
      tier: 2,
      annualImpact: 0,
      rec: {
        id: "emi-load",
        title: "Reduce the share of income going to EMIs",
        issue: `EMIs take ${(f.emiToIncome * 100).toFixed(1)}% of income, above the ${Math.round(EMI_TO_INCOME_CAUTION_RATIO * 100)}% caution level lenders commonly use.`,
        evidence: [`EMI-to-income ${(f.emiToIncome * 100).toFixed(1)}%`],
        whyItMatters: "A high fixed obligation leaves little room if income dips.",
        nextStep: "Avoid taking new debt; consider prepaying or refinancing the most expensive loan.",
        priority: { level: "high", reason: TIER_REASON[2] },
        feasibility: "Depends on the option chosen; see the loan recommendation if present.",
        tradeoffs: ["Refinancing can extend the tenure and increase total interest."],
        missingInfo: [],
        destination: ROUTES.loans,
      },
    });
  }

  // Tier 3: goals.
  const investmentBlocked = f.preferences.avoidInvestmentIncrease || liquidityAtRisk;
  const behind = f.goals.filter((g) => g.state === "ACTIVE" && !g.onTrack && g.requiredMonthly !== null);
  const overdue = f.goals.filter((g) => g.state === "OVERDUE");
  for (const g of overdue) {
    candidates.push({
      tier: 3,
      annualImpact: g.shortfall,
      rec: {
        id: `goal-overdue-${g.id}`,
        title: `Decide what to do about "${g.name}"`,
        issue: `The target date has passed and ${formatINR(g.shortfall)} is still unfunded (${g.progressPercent}% funded).`,
        evidence: [`Target ${formatINR(g.target)}`, `Saved ${formatINR(g.saved)}`],
        whyItMatters: "A goal with no live date cannot be tracked or funded sensibly.",
        nextStep: "Set a new target date or reduce the target, then the Goals page will recompute the monthly requirement.",
        priority: { level: "medium", reason: TIER_REASON[3] },
        feasibility: "No monthly figure can be given until a new date is set.",
        tradeoffs: ["A later date lowers the monthly amount but delays the goal."],
        missingInfo: ["A new target date."],
        destination: ROUTES.goals,
      },
    });
  }
  for (const g of behind) {
    const extra = Math.max(0, g.requiredMonthly! - g.monthlyContribution);
    if (investmentBlocked) {
      suppressed.push(
        f.preferences.avoidInvestmentIncrease
          ? `Raising the contribution to "${g.name}" was not suggested because you asked to avoid increasing investments.`
          : `Raising the contribution to "${g.name}" was held back until cash flow and the emergency fund are secure.`,
      );
      continue;
    }
    candidates.push({
      tier: 3,
      annualImpact: g.shortfall,
      rec: {
        id: `goal-behind-${g.id}`,
        title: `Raise the contribution to "${g.name}"`,
        issue: `You contribute ${formatINR(g.monthlyContribution)} a month but ${formatINR(g.requiredMonthly!)} is needed to finish on time (${g.progressPercent}% funded).`,
        evidence: [`Required ${formatINR(g.requiredMonthly!)}/month`, `Current ${formatINR(g.monthlyContribution)}/month`, `${g.monthsLeft} months left`],
        whyItMatters: "At the current pace the goal will finish late or short.",
        nextStep: `Increase the monthly contribution by ${formatINR(extra)}, or move the target date.`,
        estimatedImpact: { display: `Closes a ${formatINR(extra)}/month pace gap`, formula: "required monthly contribution - current monthly contribution" },
        priority: { level: "medium", reason: TIER_REASON[3] },
        feasibility: feasibility(extra, f.monthlySurplus),
        tradeoffs: ["Uses surplus that could go to other goals or debt."],
        missingInfo: [],
        destination: ROUTES.goals,
      },
    });
  }

  // Tier 3: retirement.
  if (f.retirement && !f.retirement.onTrack && f.retirement.corpusGap > 0) {
    if (investmentBlocked) {
      suppressed.push(
        f.preferences.avoidInvestmentIncrease
          ? "Raising retirement investing was not suggested because you asked to avoid increasing investments."
          : "Raising retirement investing was held back until cash flow and the emergency fund are secure.",
      );
    } else {
      candidates.push({
        tier: 3,
        annualImpact: f.retirement.corpusGap,
        rec: {
          id: "retirement-gap",
          title: "Close the retirement corpus gap",
          issue: `The retirement plan projects a gap of ${formatINR(f.retirement.corpusGap)} in ${f.retirement.yearsToRetirement} years.`,
          evidence: [`Gap ${formatINR(f.retirement.corpusGap)}`, `Years to retirement ${f.retirement.yearsToRetirement}`],
          whyItMatters: "The earlier extra money is invested, the less of it is needed.",
          nextStep: `The Retirement module estimates about ${formatINR(f.retirement.requiredMonthlySip)} a month more is needed; start with what fits your surplus.`,
          estimatedImpact: { display: `About ${formatINR(f.retirement.requiredMonthlySip)} a month`, formula: "Retirement module: monthly investment needed to fund the corpus gap" },
          priority: { level: "medium", reason: TIER_REASON[3] },
          feasibility: feasibility(f.retirement.requiredMonthlySip, f.monthlySurplus),
          tradeoffs: ["Retirement projections depend on assumed returns and inflation and are estimates, not promises."],
          missingInfo: ["Expected pension or other retirement income, if not already entered."],
          destination: ROUTES.retirement,
        },
      });
    }
  }

  // Tier 4: insurance gaps (benchmarks only).
  const gaps = f.insuranceGaps.filter((g) => !g.hasCoverage || g.gap > 0);
  if (gaps.length > 0) {
    const biggest = [...gaps].sort((a, b) => b.gap - a.gap)[0];
    candidates.push({
      tier: 4,
      annualImpact: 0,
      rec: {
        id: "insurance-gap",
        title: "Review insurance cover against benchmarks",
        issue: `${gaps.length} cover type(s) fall short of rule-of-thumb benchmarks; the largest is ${biggest.type.toLowerCase().replace(/_/g, " ")} (about ${formatINR(biggest.gap)} short).`,
        evidence: gaps.slice(0, 3).map((g) => `${g.type.toLowerCase().replace(/_/g, " ")}: ${g.hasCoverage ? `${formatINR(g.gap)} short` : "no cover logged"}`),
        whyItMatters: "Uninsured events are the largest single threat to a plan.",
        nextStep: "Check whether the gap is real (policies held elsewhere, employer cover) before buying anything.",
        priority: { level: "low", reason: TIER_REASON[4] },
        feasibility: "Premium cost depends on age, health and product; it is not estimated here.",
        tradeoffs: ["More cover means higher premiums."],
        missingInfo: ["Policies not yet logged, employer cover, dependants' needs."],
        destination: ROUTES.insurance,
      },
    });
  }

  // Tier 4: category spikes between comparable complete months.
  const spike = [...f.categoryIncreases].sort((a, b) => b.monthlyIncrease - a.monthlyIncrease)[0];
  if (spike) {
    candidates.push({
      tier: 4,
      annualImpact: spike.monthlyIncrease * 12,
      rec: {
        id: `category-spike-${spike.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        title: `Look at the rise in ${spike.name}`,
        issue: `${spike.name} rose by ${formatINR(spike.monthlyIncrease)} between the last two complete months${spike.ratio === null ? "" : ` (+${(spike.ratio * 100).toFixed(0)}%)`}.`,
        evidence: [`Increase ${formatINR(spike.monthlyIncrease)} a month`],
        whyItMatters: "A one-off is fine; a new baseline quietly lowers your savings rate.",
        nextStep: "Check whether this was one-off or recurring, and set a budget for the category if it is recurring.",
        estimatedImpact: { display: `${formatINR(spike.monthlyIncrease * 12)} a year if it persists`, formula: "monthly increase x 12" },
        priority: { level: "low", reason: TIER_REASON[4] },
        feasibility: "Within your control; no new money is needed.",
        tradeoffs: [],
        missingInfo: ["Whether the increase was planned."],
        destination: ROUTES.expenses,
      },
    });
  }

  const ranked = candidates
    .sort((a, b) => a.tier - b.tier || b.annualImpact - a.annualImpact || a.rec.id.localeCompare(b.rec.id))
    .slice(0, maxItems)
    .map((c, i) => ({ ...c.rec, rank: i + 1 }));

  return { recommendations: ranked, suppressed };
}
