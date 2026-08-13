import {
  ScenarioBaselineDTO,
  ScenarioLoanSnapshotDTO,
  ScenarioParamsByType,
  ScenarioResultDTO,
  ScenarioType,
} from "@wealthos/types";
import { amortizeOneMonth } from "../common/finance-math/amortization";

// PURE MODULE — no Prisma, no service calls, no I/O of any kind. Every function here
// takes plain data in and returns plain data out, so the same inputs always produce the
// same outputs. SimulatorService (impure) is responsible for gathering real numbers
// from the DB and handing them to these functions — never the other way around.

const PROJECTION_YEARS = 5;
const DEFAULT_ANNUAL_INVESTMENT_RETURN_PERCENT = 10;
// India-typical CPI proxy, used to grow monthly expenses over the projection window.
// This is a single aggregate rate, not a category-level model (rent vs. groceries vs.
// fuel inflate differently in reality) — documented explicitly in BASE_ASSUMPTIONS
// rather than left implicit, same "state the model so it can be surfaced in the UI"
// philosophy as the rest of this file.
const DEFAULT_ANNUAL_EXPENSE_INFLATION_PERCENT = 6;

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

// A loan as the engine needs it: enough to amortize it one month at a time. Shares its
// field semantics with ScenarioLoanSnapshotDTO (id/principal/annualRatePercent/emi) —
// re-exported under this name at the engine boundary so downstream engine code reads
// naturally, without introducing a second, divergent shape.
export type LoanAmortizationInput = ScenarioLoanSnapshotDTO;

// Advances every loan's balance by exactly one month using the same shared,
// EMI-constant, reducing-balance step (amortizeOneMonth(), in common/finance-math) that
// LoansService's amortization schedule uses — previously this was a hand-copied
// reimplementation of that same math, kept in sync manually (audit item #15). Behavior
// is unchanged: a loan whose EMI doesn't even cover interest is held flat rather than
// diverging into negative amortization, exactly matching amortizeOneMonth()'s "stuck"
// branch.
//
// Mutates `balances` in place (parallel array to `loans`) and returns the total cash
// actually paid out across all loans this month: exactly each loan's EMI in every month
// before payoff, and interest + remaining-principal (less than the nominal EMI) in the
// single final month a loan is paid off. A loan already at/below zero balance is skipped
// entirely — it contributes no further cash outflow, which is what lets its freed-up EMI
// show up as extra idle cash surplus automatically from that month on.
function stepLoansOneMonth(balances: number[], loans: LoanAmortizationInput[]): number {
  let totalOutflow = 0;
  for (let i = 0; i < loans.length; i++) {
    const balance = balances[i];
    if (balance <= 0) continue;

    const step = amortizeOneMonth(balance, loans[i].annualRatePercent, loans[i].emi);

    if (step.stuck) {
      // EMI doesn't cover interest — stuck, same safety branch as
      // computeAmortizationSchedule(). The borrower still pays the EMI in cash; the
      // balance just doesn't shrink.
      totalOutflow += loans[i].emi;
      continue;
    }

    balances[i] = step.newBalance;
    totalOutflow += step.principalPaid + step.interest;
  }
  return totalOutflow;
}

interface ProjectionInputs {
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyInvestmentContribution: number; // SIP-style, compounds at annualReturnPercent
  investmentsValue: number;
  debt: number; // any flat, non-loan-level debt not covered by `loans` below
  months: number;
  annualReturnPercent?: number;
  // When omitted (or empty), the engine falls back to the original closed-form
  // calculation with `debt` held flat — this is what guarantees zero behavioral drift
  // for every existing caller that doesn't opt into loan-level detail (Scenario
  // Studio's sensitivity sweep, and this file's own low-level unit tests).
  loans?: LoanAmortizationInput[];
  // Annual %, applied to `monthlyExpenses` as a monthly-compounding growth rate. Only
  // takes effect on the month-by-month path (i.e. when `loans` is supplied) — the
  // closed-form fallback path never modeled inflation and continues not to, so it stays
  // byte-for-byte identical to its original behavior when `loans` isn't provided.
  expenseInflationPercent?: number;
}

// Model (stated explicitly so it can be surfaced in the UI, not hidden):
// - Existing + new monthly investment contributions compound at annualReturnPercent.
// - Leftover monthly cash surplus (income − expenses − investment contribution − loan
//   EMI outflow) accumulates linearly with NO return — it's modeled as idle cash, not
//   auto-invested.
// - When `loans` is supplied, every loan amortizes month-by-month (EMI-constant,
//   reducing-balance — identical math to Loans → Amortization) and monthly expenses
//   grow at `expenseInflationPercent`/year; when it isn't, `debt` is held flat and
//   expenses don't inflate, preserving the original simpler model for callers that
//   don't have loan-level detail available.
export function projectNetWorth(input: ProjectionInputs): number {
  const monthlyRate = (input.annualReturnPercent ?? DEFAULT_ANNUAL_INVESTMENT_RETURN_PERCENT) / 12 / 100;

  if (!input.loans || input.loans.length === 0) {
    const projectedInvestments =
      compound(input.investmentsValue, monthlyRate, input.months) +
      futureValueSeries(input.monthlyInvestmentContribution, monthlyRate, input.months);
    const monthlyCashSurplus = input.monthlyIncome - input.monthlyExpenses - input.monthlyInvestmentContribution;
    const accumulatedCash = monthlyCashSurplus * input.months;
    return accumulatedCash + projectedInvestments - input.debt;
  }

  const monthlyInflationRate = (input.expenseInflationPercent ?? 0) / 12 / 100;
  const balances = input.loans.map((l) => l.principal);
  let investmentBalance = input.investmentsValue;
  let idleCash = 0;

  for (let m = 1; m <= input.months; m++) {
    const inflatedExpenses = input.monthlyExpenses * Math.pow(1 + monthlyInflationRate, m - 1);
    const emiOutflow = stepLoansOneMonth(balances, input.loans);
    const cashSurplus = input.monthlyIncome - inflatedExpenses - input.monthlyInvestmentContribution - emiOutflow;
    idleCash += cashSurplus;
    investmentBalance = investmentBalance * (1 + monthlyRate) + input.monthlyInvestmentContribution;
  }

  const remainingLoanDebt = balances.reduce((sum, b) => sum + Math.max(0, b), 0);
  return idleCash + investmentBalance - remainingLoanDebt - input.debt;
}

const BASE_ASSUMPTIONS = [
  `${PROJECTION_YEARS}-year projection horizon`,
  `Investments assumed to grow at ${DEFAULT_ANNUAL_INVESTMENT_RETURN_PERCENT}%/year`,
  "Idle monthly cash surplus is not auto-invested in this model — only explicit SIP/investment contributions compound",
  "Existing loans are amortized month-by-month using each loan's real rate and EMI (the same reducing-balance amortization schedule as Loans → Amortization) — debt is no longer held flat over the horizon",
  `Monthly expenses are assumed to grow at ${DEFAULT_ANNUAL_EXPENSE_INFLATION_PERCENT}%/year (an aggregate, India-typical CPI proxy) — the engine still doesn't model category-level inflation differences, just one blended rate`,
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
    // Overrides the loan portfolio used for the SCENARIO side of the projection only
    // (e.g. a new home loan added, or an existing loan's principal reduced by a
    // prepayment). The baseline side always uses the user's real, unmodified loans.
    loans?: LoanAmortizationInput[];
    // Extra recurring EMI cash outflow to reflect in the *displayed* monthlyCashflowDelta
    // headline figure. The deep 5-year projection itself derives EMI outflow directly
    // from `loans`/`effect.loans` above — this only affects the summary number shown to
    // the user, not the compounding math.
    monthlyEmiDelta?: number;
  },
  narrative: string,
  goalImpact: string,
  extraAssumptions: string[] = [],
  // Only SIP_DECREASE needs this: it compares "this amount keeps compounding" (the
  // baseline) against "it stops and sits idle" (the scenario) — every other scenario
  // compares against the plain baseline (0 extra contribution).
  baselineEffect: { monthlyInvestmentContribution?: number } = {},
): ScenarioResultDTO {
  const baselineLoans: LoanAmortizationInput[] = baseline.loans ?? [];

  const baselineProjection = projectNetWorth({
    monthlyIncome: baseline.monthlyIncome,
    monthlyExpenses: baseline.monthlyExpenses,
    monthlyInvestmentContribution: baselineEffect.monthlyInvestmentContribution ?? 0,
    investmentsValue: baseline.investmentsValue,
    debt: 0,
    loans: baselineLoans,
    expenseInflationPercent: DEFAULT_ANNUAL_EXPENSE_INFLATION_PERCENT,
    months: scenarioMonths,
  });

  const scenarioProjection =
    projectNetWorth({
      monthlyIncome: effect.monthlyIncome ?? baseline.monthlyIncome,
      monthlyExpenses: effect.monthlyExpenses ?? baseline.monthlyExpenses,
      monthlyInvestmentContribution: effect.monthlyInvestmentContribution ?? 0,
      investmentsValue: baseline.investmentsValue,
      debt: 0,
      loans: effect.loans ?? baselineLoans,
      expenseInflationPercent: DEFAULT_ANNUAL_EXPENSE_INFLATION_PERCENT,
      months: scenarioMonths,
    }) + (effect.immediateNetWorthDelta ?? 0);

  const monthlyCashflowDelta =
    (effect.monthlyIncome ?? baseline.monthlyIncome) -
    (effect.monthlyExpenses ?? baseline.monthlyExpenses) -
    (effect.monthlyInvestmentContribution ?? 0) -
    (effect.monthlyEmiDelta ?? 0) -
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
  const loans: LoanAmortizationInput[] = baseline.loans ?? [];

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
      const newLoan: LoanAmortizationInput = {
        id: "__house_purchase_new_loan__",
        principal: loanPrincipal,
        annualRatePercent: p.loanInterestRateAnnual,
        emi,
      };
      return buildResult(
        scenarioType,
        baseline,
        months,
        {
          loans: [...loans, newLoan],
          monthlyEmiDelta: emi,
          immediateNetWorthDelta: p.propertyValue - downPayment - loanPrincipal, // = 0, but explicit for clarity
        },
        `Buying a ₹${p.propertyValue.toFixed(0)} property with ${p.downPaymentPercent}% down adds a ₹${emi.toFixed(0)}/month EMI on a new ₹${loanPrincipal.toFixed(0)} loan.`,
        emi > baseline.monthlyIncome - baseline.monthlyExpenses
          ? "The new EMI alone would exceed current monthly surplus — other goals would likely need to pause."
          : "Other goal contributions may need to shrink to accommodate the new EMI.",
        [
          `New loan: ₹${loanPrincipal.toFixed(0)} at ${p.loanInterestRateAnnual}%/year over ${p.loanTenureMonths} months`,
          "The new loan is included alongside your existing loans in the month-by-month amortization, so the projection reflects its principal actually being paid down, not a static balance",
          "Property value appreciation isn't modeled in this scenario — the home itself isn't counted as an asset, so buying it is net-zero at the moment of purchase (down payment spent, loan taken) and only the ongoing financing cost shows up afterward",
        ],
      );
    }

    case "LOAN_PREPAYMENT": {
      const p = params as ScenarioParamsByType["LOAN_PREPAYMENT"];
      const interestSaved = context.loanPrepayment?.interestSaved ?? 0;
      const monthsSaved = context.loanPrepayment?.monthsSaved ?? 0;
      // Reduces this specific loan's principal for the scenario side only; every other
      // loan (and, for the baseline side, this loan too) amortizes unchanged. If the
      // loan isn't found in `loans` (e.g. stale/invalid id), scenarioLoans is identical
      // to baseline and only the immediate cash outflow below reflects the prepayment.
      const scenarioLoans = loans.map((l) =>
        l.id === p.loanId ? { ...l, principal: Math.max(0, l.principal - p.lumpSum) } : l,
      );
      return buildResult(
        scenarioType,
        baseline,
        months,
        { immediateNetWorthDelta: -p.lumpSum, loans: scenarioLoans },
        `Prepaying ₹${p.lumpSum.toFixed(0)} on this loan saves an estimated ₹${interestSaved.toFixed(0)} in interest and shortens the tenure by about ${monthsSaved} month(s) over its full remaining life.`,
        "Reduces long-term debt burden and frees up the EMI sooner, which can be redirected to other goals once the loan closes early.",
        [
          "Interest/tenure savings quoted in the narrative come from the real amortization schedule for this loan (LoansService.prepaymentImpact) over its full remaining tenure, which may extend beyond this 5-year window",
          "Within the 5-year projection, this loan (and every other loan) is amortized month-by-month, so the net-worth figure reflects the loan's balance actually shrinking faster after prepayment, not a one-time flat adjustment",
        ],
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
        debt: 0,
        loans,
        expenseInflationPercent: DEFAULT_ANNUAL_EXPENSE_INFLATION_PERCENT,
        months: oldYears * 12,
      });
      const corpusAtNewAge = projectNetWorth({
        monthlyIncome: baseline.monthlyIncome,
        monthlyExpenses: baseline.monthlyExpenses,
        monthlyInvestmentContribution: 0,
        investmentsValue: baseline.investmentsValue,
        debt: 0,
        loans,
        expenseInflationPercent: DEFAULT_ANNUAL_EXPENSE_INFLATION_PERCENT,
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

    // NEW (audit item #8): a new/expansion loan not tied to purchasing a house —
    // business expansion, a personal loan, equipment financing, etc. Modeling choice,
    // stated explicitly (mirroring HOUSE_PURCHASE's own documented choice above):
    // immediateNetWorthDelta is 0 — the borrowed cash is assumed spent/deployed
    // immediately on something this model doesn't track as an ongoing asset (e.g.
    // business inventory, equipment, working capital), and the model doesn't credit or
    // debit that spend explicitly. The ONLY effect this scenario has on the projection
    // is the new loan's own amortization (via `loans`) and its EMI's drag on monthly
    // cashflow — i.e. "buying" the loan's use is a wash at the moment of borrowing, same
    // as HOUSE_PURCHASE's undocumented house-value credit/down-payment debit, and only
    // the ongoing financing cost compounds afterward.
    case "NEW_LOAN": {
      const p = params as ScenarioParamsByType["NEW_LOAN"];
      const emi = calculateEmi(p.loanAmount, p.annualRatePercent, p.tenureMonths);
      const newLoan: LoanAmortizationInput = {
        id: "__new_loan__",
        principal: p.loanAmount,
        annualRatePercent: p.annualRatePercent,
        emi,
      };
      const purposeSuffix = p.purpose ? ` for ${p.purpose}` : "";
      return buildResult(
        scenarioType,
        baseline,
        months,
        {
          loans: [...loans, newLoan],
          monthlyEmiDelta: emi,
        },
        `Taking on a new ₹${p.loanAmount.toFixed(0)} loan${purposeSuffix} at ${p.annualRatePercent}%/year over ${p.tenureMonths} months adds a ₹${emi.toFixed(0)}/month EMI.`,
        emi > baseline.monthlyIncome - baseline.monthlyExpenses
          ? "The new EMI alone would exceed current monthly surplus — other goals would likely need to pause."
          : "Other goal contributions may need to shrink to accommodate the new EMI.",
        [
          `New loan: ₹${p.loanAmount.toFixed(0)} at ${p.annualRatePercent}%/year over ${p.tenureMonths} months`,
          "The new loan is included alongside your existing loans in the month-by-month amortization, so the projection reflects its principal actually being paid down, not a static balance",
          "The borrowed amount is modeled as spent/deployed immediately (e.g. business expansion, equipment, working capital) rather than held as a tracked asset — like HOUSE_PURCHASE, there's no offsetting asset value credited, so the net effect at the moment of borrowing is a wash and only the ongoing EMI cost shows up over time",
        ],
      );
    }

    default: {
      const _exhaustive: never = scenarioType;
      throw new Error(`Unsupported scenario type: ${_exhaustive}`);
    }
  }
}
