import { ScenarioBaselineDTO, ScenarioParamsByType, ScenarioResultDTO, ScenarioType } from "@wealthos/types";

// PURE MODULE — no Prisma, no service calls, no I/O of any kind. Every function here
// takes plain data in and returns plain data out, so the same inputs always produce the
// same outputs. SimulatorService (impure) is responsible for gathering real numbers
// from the DB and handing them to these functions — never the other way around.

const PROJECTION_YEARS = 5;
const DEFAULT_ANNUAL_INVESTMENT_RETURN_PERCENT = 10;

function compound(principal: number, monthlyRate: number, months: number): number {
  return principal * Math.pow(1 + monthlyRate, months);
}

// Future value of a level monthly contribution series (an ordinary annuity).
function futureValueSeries(monthlyContribution: number, monthlyRate: number, months: number): number {
  if (months <= 0) return 0;
  if (monthlyRate === 0) return monthlyContribution * months;
  return monthlyContribution * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
}

export function calculateEmi(principal: number, annualRatePercent: number, tenureMonths: number): number {
  if (tenureMonths <= 0 || principal <= 0) return 0;
  const monthlyRate = annualRatePercent / 12 / 100;
  if (monthlyRate === 0) return principal / tenureMonths;
  const factor = Math.pow(1 + monthlyRate, tenureMonths);
  return (principal * monthlyRate * factor) / (factor - 1);
}

interface ProjectionInputs {
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyInvestmentContribution: number; // SIP-style, compounds at annualReturnPercent
  investmentsValue: number;
  debt: number;
  months: number;
  annualReturnPercent?: number;
}

// Model (stated explicitly so it can be surfaced in the UI, not hidden):
// - Existing + new monthly investment contributions compound at annualReturnPercent.
// - Leftover monthly cash surplus (income − expenses − investment contribution)
//   accumulates linearly with NO return — it's modeled as idle cash, not auto-invested.
// - Debt is held constant over the horizon unless a scenario explicitly changes it
//   (loan amortization during the projection window isn't modeled — see assumptions).
export function projectNetWorth(input: ProjectionInputs): number {
  const monthlyRate = (input.annualReturnPercent ?? DEFAULT_ANNUAL_INVESTMENT_RETURN_PERCENT) / 12 / 100;
  const projectedInvestments =
    compound(input.investmentsValue, monthlyRate, input.months) +
    futureValueSeries(input.monthlyInvestmentContribution, monthlyRate, input.months);
  const monthlyCashSurplus = input.monthlyIncome - input.monthlyExpenses - input.monthlyInvestmentContribution;
  const accumulatedCash = monthlyCashSurplus * input.months;
  return accumulatedCash + projectedInvestments - input.debt;
}

const BASE_ASSUMPTIONS = [
  `${PROJECTION_YEARS}-year projection horizon`,
  `Investments assumed to grow at ${DEFAULT_ANNUAL_INVESTMENT_RETURN_PERCENT}%/year`,
  "Idle monthly cash surplus is not auto-invested in this model — only explicit SIP/investment contributions compound",
  "Outstanding debt is held constant over the horizon unless the scenario itself changes it",
];

function buildResult(
  scenarioType: ScenarioType,
  baseline: ScenarioBaselineDTO,
  scenarioMonths: number,
  effect: {
    monthlyIncome?: number;
    monthlyExpenses?: number;
    monthlyInvestmentContribution?: number;
    immediateNetWorthDelta?: number;
    debtDelta?: number;
  },
  narrative: string,
  goalImpact: string,
  extraAssumptions: string[] = [],
  // Only SIP_DECREASE needs this: it compares "this amount keeps compounding" (the
  // baseline) against "it stops and sits idle" (the scenario) — every other scenario
  // compares against the plain baseline (0 extra contribution).
  baselineEffect: { monthlyInvestmentContribution?: number } = {},
): ScenarioResultDTO {
  const baselineProjection = projectNetWorth({
    monthlyIncome: baseline.monthlyIncome,
    monthlyExpenses: baseline.monthlyExpenses,
    monthlyInvestmentContribution: baselineEffect.monthlyInvestmentContribution ?? 0,
    investmentsValue: baseline.investmentsValue,
    debt: baseline.totalDebt,
    months: scenarioMonths,
  });

  const scenarioProjection =
    projectNetWorth({
      monthlyIncome: effect.monthlyIncome ?? baseline.monthlyIncome,
      monthlyExpenses: effect.monthlyExpenses ?? baseline.monthlyExpenses,
      monthlyInvestmentContribution: effect.monthlyInvestmentContribution ?? 0,
      investmentsValue: baseline.investmentsValue,
      debt: baseline.totalDebt + (effect.debtDelta ?? 0),
      months: scenarioMonths,
    }) + (effect.immediateNetWorthDelta ?? 0);

  const monthlyCashflowDelta =
    (effect.monthlyIncome ?? baseline.monthlyIncome) -
    (effect.monthlyExpenses ?? baseline.monthlyExpenses) -
    (effect.monthlyInvestmentContribution ?? 0) -
    (baseline.monthlyIncome - baseline.monthlyExpenses - (baselineEffect.monthlyInvestmentContribution ?? 0));

  return {
    scenarioType,
    monthlyCashflowDelta: monthlyCashflowDelta.toFixed(2),
    netWorthDeltaIn5Years: (scenarioProjection - baselineProjection).toFixed(2),
    projectedNetWorthIn5Years: scenarioProjection.toFixed(2),
    goalImpact,
    assumptions: [...BASE_ASSUMPTIONS, ...extraAssumptions],
    narrative,
    isProjectionOnly: true,
  };
}

// context carries real, already-computed numbers the (impure) service layer fetched
// from other services — e.g. a real amortization result from LoansService, or the
// user's actual retirement corpus target from RetirementService. The engine itself
// never fetches these; it just combines already-known numbers deterministically.
export interface ScenarioContext {
  loanPrepayment?: { interestSaved: number; monthsSaved: number; newTenureMonths: number };
  retirementCorpusRequired?: number;
  goalDelay?: { goalName: string; currentRequiredMonthlyContribution: number; newRequiredMonthlyContribution: number };
}

export function runScenario<T extends ScenarioType>(
  scenarioType: T,
  params: ScenarioParamsByType[T],
  baseline: ScenarioBaselineDTO,
  context: ScenarioContext = {},
): ScenarioResultDTO {
  const months = PROJECTION_YEARS * 12;

  switch (scenarioType) {
    case "SALARY_HIKE": {
      const p = params as ScenarioParamsByType["SALARY_HIKE"];
      const newIncome = baseline.monthlyIncome * (1 + p.percentIncrease / 100);
      return buildResult(
        scenarioType,
        baseline,
        months,
        { monthlyIncome: newIncome },
        `A ${p.percentIncrease}% salary hike raises monthly income to roughly ₹${newIncome.toFixed(0)}.`,
        "Higher income increases headroom for existing goal contributions, but doesn't automatically redirect toward them.",
      );
    }

    case "SALARY_DROP": {
      const p = params as ScenarioParamsByType["SALARY_DROP"];
      const newIncome = Math.max(0, baseline.monthlyIncome * (1 - p.percentDecrease / 100));
      return buildResult(
        scenarioType,
        baseline,
        months,
        { monthlyIncome: newIncome },
        `A ${p.percentDecrease}% income drop reduces monthly income to roughly ₹${newIncome.toFixed(0)}.`,
        newIncome < baseline.monthlyExpenses
          ? "Projected income would no longer cover current monthly expenses — existing goal contributions are at serious risk."
          : "Existing goal contributions may need to shrink to preserve the same savings rate.",
      );
    }

    case "SIP_INCREASE": {
      const p = params as ScenarioParamsByType["SIP_INCREASE"];
      return buildResult(
        scenarioType,
        baseline,
        months,
        { monthlyInvestmentContribution: p.additionalMonthlyAmount },
        `An additional ₹${p.additionalMonthlyAmount}/month redirected from idle cash into investments.`,
        "Goal timelines that depend on investment growth (retirement, long-term goals) improve; short-term cash-based goals see no change.",
        ["The additional SIP amount is assumed to come from otherwise-idle monthly cash surplus, not from new income"],
      );
    }

    case "SIP_DECREASE": {
      const p = params as ScenarioParamsByType["SIP_DECREASE"];
      return buildResult(
        scenarioType,
        baseline,
        months,
        // The reduced amount sits idle instead of being invested — 0 extra contribution
        // in the scenario itself. Compared against a baseline that keeps investing it
        // (passed as baselineEffect below), so the delta reflects the compounding given up.
        { monthlyInvestmentContribution: 0 },
        `Reducing SIP by ₹${p.reducedMonthlyAmount}/month frees up cash but slows investment compounding.`,
        "Long-term goals funded by this SIP will take longer to reach or need a higher future contribution to catch up.",
        ["Reduced SIP amount is assumed to sit as idle cash rather than being invested elsewhere"],
        { monthlyInvestmentContribution: p.reducedMonthlyAmount },
      );
    }

    case "HOUSE_PURCHASE": {
      const p = params as ScenarioParamsByType["HOUSE_PURCHASE"];
      const downPayment = p.propertyValue * (p.downPaymentPercent / 100);
      const loanPrincipal = p.propertyValue - downPayment;
      const emi = calculateEmi(loanPrincipal, p.loanInterestRateAnnual, p.loanTenureMonths);
      return buildResult(
        scenarioType,
        baseline,
        months,
        {
          monthlyExpenses: baseline.monthlyExpenses + emi,
          immediateNetWorthDelta: p.propertyValue - downPayment - loanPrincipal, // = 0, but explicit for clarity
          debtDelta: loanPrincipal,
        },
        `Buying a ₹${p.propertyValue.toFixed(0)} property with ${p.downPaymentPercent}% down adds a ₹${emi.toFixed(0)}/month EMI.`,
        emi > baseline.monthlyIncome - baseline.monthlyExpenses
          ? "The new EMI alone would exceed current monthly surplus — other goals would likely need to pause."
          : "Other goal contributions may need to shrink to accommodate the new EMI.",
        [
          `New loan: ₹${loanPrincipal.toFixed(0)} at ${p.loanInterestRateAnnual}%/year over ${p.loanTenureMonths} months`,
          "Loan principal is treated as constant over the 5-year horizon (amortization paydown isn't modeled here — see Loans → Amortization for the real schedule)",
          "Property value appreciation isn't modeled in this scenario",
        ],
      );
    }

    case "LOAN_PREPAYMENT": {
      const p = params as ScenarioParamsByType["LOAN_PREPAYMENT"];
      const interestSaved = context.loanPrepayment?.interestSaved ?? 0;
      const monthsSaved = context.loanPrepayment?.monthsSaved ?? 0;
      return buildResult(
        scenarioType,
        baseline,
        months,
        { immediateNetWorthDelta: -p.lumpSum + interestSaved, debtDelta: -p.lumpSum },
        `Prepaying ₹${p.lumpSum.toFixed(0)} on this loan saves an estimated ₹${interestSaved.toFixed(0)} in interest and shortens the tenure by about ${monthsSaved} month(s).`,
        "Reduces long-term debt burden and frees up the EMI sooner, which can be redirected to other goals once the loan closes early.",
        ["Interest/tenure savings come from the real amortization schedule for this loan, not an approximation"],
      );
    }

    case "RETIREMENT_AGE_SHIFT": {
      const p = params as ScenarioParamsByType["RETIREMENT_AGE_SHIFT"];
      const currentAge = baseline.currentAge ?? 30;
      const oldYears = Math.max(1, baseline.targetRetirementAge - currentAge);
      const newYears = Math.max(1, p.newRetirementAge - currentAge);
      const monthsDelta = (newYears - oldYears) * 12;
      const corpusRequired = context.retirementCorpusRequired;

      // This scenario genuinely compares two different horizons (retire at the old age
      // vs. the new age) — buildResult's single-horizon comparison can't express that,
      // so both projections are computed directly here instead.
      const corpusAtOldAge = projectNetWorth({
        monthlyIncome: baseline.monthlyIncome,
        monthlyExpenses: baseline.monthlyExpenses,
        monthlyInvestmentContribution: 0,
        investmentsValue: baseline.investmentsValue,
        debt: baseline.totalDebt,
        months: oldYears * 12,
      });
      const corpusAtNewAge = projectNetWorth({
        monthlyIncome: baseline.monthlyIncome,
        monthlyExpenses: baseline.monthlyExpenses,
        monthlyInvestmentContribution: 0,
        investmentsValue: baseline.investmentsValue,
        debt: baseline.totalDebt,
        months: newYears * 12,
      });

      return {
        scenarioType,
        monthlyCashflowDelta: "0.00", // this scenario doesn't change monthly cashflow
        netWorthDeltaIn5Years: (corpusAtNewAge - corpusAtOldAge).toFixed(2),
        projectedNetWorthIn5Years: corpusAtNewAge.toFixed(2),
        goalImpact:
          corpusRequired !== undefined
            ? `Against a required corpus of ₹${corpusRequired.toFixed(0)}, retiring at ${p.newRetirementAge} projects ₹${corpusAtNewAge.toFixed(0)} versus ₹${corpusAtOldAge.toFixed(0)} at age ${baseline.targetRetirementAge}.`
            : "No retirement profile found — set one up under Retirement for a corpus-aware comparison.",
        assumptions: [
          ...BASE_ASSUMPTIONS.filter((a) => !a.includes("5-year")),
          `Compares projected corpus at age ${baseline.targetRetirementAge} (${oldYears}y away) versus age ${p.newRetirementAge} (${newYears}y away) — not the standard 5-year window`,
        ],
        narrative: `Shifting retirement from age ${baseline.targetRetirementAge} to ${p.newRetirementAge} changes the investing horizon by ${monthsDelta >= 0 ? "+" : ""}${monthsDelta} months.`,
        isProjectionOnly: true,
      };
    }

    case "EMERGENCY_EXPENSE": {
      const p = params as ScenarioParamsByType["EMERGENCY_EXPENSE"];
      return buildResult(
        scenarioType,
        baseline,
        months,
        { immediateNetWorthDelta: -p.amount },
        `An unplanned ₹${p.amount.toFixed(0)} expense is deducted immediately from net worth.`,
        p.amount > baseline.netWorth
          ? "This expense would exceed current net worth — it would likely require debt or liquidating investments at a loss."
          : "Absorbable from current net worth, but it delays whatever that cash was earmarked for (e.g. an emergency fund goal).",
        ["Assumed paid as a one-time lump sum from existing net worth, not financed"],
      );
    }

    case "GOAL_DELAY": {
      const p = params as ScenarioParamsByType["GOAL_DELAY"];
      const goalName = context.goalDelay?.goalName ?? "this goal";
      const current = context.goalDelay?.currentRequiredMonthlyContribution;
      const updated = context.goalDelay?.newRequiredMonthlyContribution;
      return buildResult(
        scenarioType,
        baseline,
        months,
        {}, // delaying a goal's target date doesn't itself move any money — net worth
            // trajectory is unaffected; only the goal's required contribution changes
        `Pushing "${goalName}" back by ${p.delayMonths} month(s) doesn't change your cashflow or net worth trajectory by itself.`,
        current !== undefined && updated !== undefined
          ? `Required monthly contribution for "${goalName}" would drop from ₹${current.toFixed(0)} to ₹${updated.toFixed(0)}/month with the extra time.`
          : `Goal "${goalName}" not found — required contribution can't be recomputed.`,
        ["This scenario only recomputes the goal's required monthly contribution; it does not move money or change other goals"],
      );
    }

    default: {
      const _exhaustive: never = scenarioType;
      throw new Error(`Unsupported scenario type: ${_exhaustive}`);
    }
  }
}
