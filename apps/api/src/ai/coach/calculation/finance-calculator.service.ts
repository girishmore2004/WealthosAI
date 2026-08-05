import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { calculateEmi } from "../../../simulator/simulator.engine";
import { computeMonthlySurplus, maxAffordablePrincipal } from "../../scenario-studio/affordability.util";
import { LoansService } from "../../../loans/loans.service";
import { RetirementService } from "../../../retirement/retirement.service";
import { TaxService } from "../../../tax/tax.service";
import { currentFinancialYear } from "../../../common/utils/financial-year.util";
import { formatINR } from "../../../common/utils/currency.util";

// --- THE CALCULATOR AGENT -----------------------------------------------------------
//
// Every method on this service is a PURE or DB-read-only deterministic calculation —
// nothing here ever calls the AI Gateway. This is deliberate and load-bearing: the
// Calculator Agent is what lets the Planner/Composer/Verifier agents treat a rupee
// figure as "grounded" without re-deriving it themselves, and what lets
// NumericConsistencyVerifier/VerifierAgentService trust that any number appearing in
// `factsText` actually came from real math, not a model's guess.
//
// Design choice: this service does NOT reimplement EMI/annuity/retirement math from
// scratch. It imports the same pure functions Scenario Studio and the Simulator engine
// already use (`calculateEmi` from simulator.engine.ts, `computeMonthlySurplus` /
// `maxAffordablePrincipal` from scenario-studio/affordability.util.ts) and delegates to
// LoansService/RetirementService/TaxService for anything that needs a user's actual
// stored records (a loan's current schedule, a retirement profile's corpus gap, a tax
// estimate for the current FY). One formula, one place, reused everywhere — the same
// principle the codebase already applies for calculateEmi across Simulator and
// Scenario Studio.
@Injectable()
export class FinanceCalculatorService {
  constructor(
    private loans: LoansService,
    private retirement: RetirementService,
    private tax: TaxService,
  ) {}

  // --- EMI / loan math ---------------------------------------------------------------

  /** A standalone "what would my EMI be" hypothetical — no DB read, pure formula. */
  emiForHypotheticalLoan(principal: number, annualRatePercent: number, tenureMonths: number): {
    emi: number;
    totalPayable: number;
    totalInterest: number;
  } {
    const emi = calculateEmi(principal, annualRatePercent, tenureMonths);
    const totalPayable = emi * tenureMonths;
    return {
      emi: Number(emi.toFixed(2)),
      totalPayable: Number(totalPayable.toFixed(2)),
      totalInterest: Number((totalPayable - principal).toFixed(2)),
    };
  }

  /** Inverts the EMI formula — "how big a loan can I afford at this EMI budget" —
   * reusing the exact function Scenario Studio's HOUSE_PURCHASE variant uses, so the
   * Coach and Scenario Studio can never disagree on this number. */
  maxAffordableLoanPrincipal(maxMonthlyEmi: number, annualRatePercent: number, tenureMonths: number): number {
    return Number(maxAffordablePrincipal(maxMonthlyEmi, annualRatePercent, tenureMonths).toFixed(2));
  }

  /** Real payoff-timeline math for a specific existing loan, given an optional extra
   * monthly overpayment on top of its current EMI — used by the Planner Agent when
   * building a DEBT_PAYOFF plan's steps/target date, and by the Calculator path when
   * the user asks "what if I pay ₹X extra a month". Delegates entirely to
   * LoansService.prepaymentImpact/amortizationSchedule (the same engine
   * SimulatorService and the loans/:id/prepayment-impact route already use) rather
   * than re-deriving amortization here. */
  async loanPayoffWithExtraMonthly(userId: string, loanId: string, extraMonthlyPayment: number): Promise<{
    monthsToPayoff: number;
    interestSaved: number;
    monthsSaved: number;
    projectedPayoffDate: string;
  }> {
    const schedule = await this.loans.amortizationSchedule(userId, loanId);
    const currentMonths = schedule.length;

    if (extraMonthlyPayment <= 0) {
      return {
        monthsToPayoff: currentMonths,
        interestSaved: 0,
        monthsSaved: 0,
        projectedPayoffDate: this.monthsFromNow(currentMonths),
      };
    }

    // LoansService.prepaymentImpact() models a one-time lump sum, not a recurring
    // extra monthly payment. An equivalent, honestly-labeled approximation: treat N
    // months of the proposed extra payment as if paid today as a single lump sum,
    // re-run month by month until the schedule length stabilizes (extra payment this
    // month shortens the horizon, which changes how many months of "extra" apply) —
    // capped at 3 iterations, which converges in practice for any real EMI/tenure
    // combination because each iteration's horizon can only shrink.
    let estimatedMonths = currentMonths;
    for (let i = 0; i < 3; i++) {
      const lumpSumEquivalent = extraMonthlyPayment * estimatedMonths;
      const impact = await this.loans.prepaymentImpact(userId, loanId, lumpSumEquivalent);
      if (impact.newTenureMonths === estimatedMonths) break;
      estimatedMonths = impact.newTenureMonths;
    }

    const finalLumpSumEquivalent = extraMonthlyPayment * estimatedMonths;
    const impact = await this.loans.prepaymentImpact(userId, loanId, finalLumpSumEquivalent);

    return {
      monthsToPayoff: impact.newTenureMonths,
      interestSaved: impact.interestSaved,
      monthsSaved: impact.monthsSaved,
      projectedPayoffDate: this.monthsFromNow(impact.newTenureMonths),
    };
  }

  // --- Savings / goal projection math -------------------------------------------------

  /** Future value of a lump sum plus a level monthly contribution series, compounded
   * monthly — the standard savings-goal projection formula. Pure, no DB access. Kept
   * as its own small function here (rather than importing simulator.engine.ts's
   * private, unexported `compound`/`futureValueSeries`) since those are intentionally
   * not exported — this is a deliberate, documented, small duplication of the same
   * textbook formula, not a divergent one: same reducing/compounding math, verified
   * against calculateEmi's own monthly-rate convention (annualRatePercent / 12 / 100). */
  projectSavingsGoal(input: {
    currentAmount: number;
    monthlyContribution: number;
    annualReturnPercent: number;
    months: number;
  }): { projectedValue: number; totalContributed: number; totalGrowth: number } {
    const { currentAmount, monthlyContribution, annualReturnPercent, months } = input;
    const monthlyRate = annualReturnPercent / 12 / 100;

    const grownCurrent =
      Math.abs(monthlyRate) < 0.0001 ? currentAmount : currentAmount * Math.pow(1 + monthlyRate, months);
    const contributionFv =
      Math.abs(monthlyRate) < 0.0001
        ? monthlyContribution * months
        : monthlyContribution * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);

    const projectedValue = grownCurrent + contributionFv;
    const totalContributed = currentAmount + monthlyContribution * months;

    return {
      projectedValue: Number(projectedValue.toFixed(2)),
      totalContributed: Number(totalContributed.toFixed(2)),
      totalGrowth: Number((projectedValue - totalContributed).toFixed(2)),
    };
  }

  /** Required level monthly contribution to close a gap over a given horizon at a
   * given assumed return — the inverse of projectSavingsGoal's contribution term.
   * Used by the Planner Agent to set a SAVINGS_TARGET plan's pace, and directly for
   * calculation_request questions like "how much do I need to save monthly". */
  requiredMonthlySavingsContribution(input: {
    targetAmount: number;
    currentAmount: number;
    annualReturnPercent: number;
    months: number;
  }): number {
    const { targetAmount, currentAmount, annualReturnPercent, months } = input;
    if (months <= 0) return Math.max(0, targetAmount - currentAmount);

    const monthlyRate = annualReturnPercent / 12 / 100;
    const grownCurrent =
      Math.abs(monthlyRate) < 0.0001 ? currentAmount : currentAmount * Math.pow(1 + monthlyRate, months);
    const remainingGap = Math.max(0, targetAmount - grownCurrent);
    if (remainingGap === 0) return 0;

    const required =
      Math.abs(monthlyRate) < 0.0001
        ? remainingGap / months
        : (remainingGap * monthlyRate) / (Math.pow(1 + monthlyRate, months) - 1);

    return Number(Math.max(0, required).toFixed(2));
  }

  /** Same surplus formula the Phase 12 goal_conflict gatherer and Scenario Studio's
   * affordability util both already use — imported, not re-derived, so this agent can
   * never disagree with either of them on "how much room does this user actually
   * have". */
  monthlySurplus(monthlyIncome: number, monthlyExpenses: number, totalMonthlyEmi: number): number {
    return Number(computeMonthlySurplus(monthlyIncome, monthlyExpenses, totalMonthlyEmi).toFixed(2));
  }

  // --- Retirement --------------------------------------------------------------------

  /** Delegates entirely to RetirementService.computePlan — the same PV/FV annuity
   * math the Retirement module's own page uses. The Calculator Agent's job here is
   * only to expose it under a name the Coach's other agents call uniformly, never to
   * recompute it differently. */
  async retirementCorpusGap(userId: string): Promise<{
    corpusRequired: number;
    corpusGap: number;
    requiredMonthlySip: number;
    yearsToRetirement: number;
  }> {
    const plan = await this.retirement.computePlan(userId);
    return {
      corpusRequired: Number(plan.corpusRequired),
      corpusGap: Number(plan.corpusGap),
      requiredMonthlySip: Number(plan.requiredMonthlySip),
      yearsToRetirement: plan.yearsToRetirement,
    };
  }

  // --- Tax -----------------------------------------------------------------------------

  /** Delegates to TaxService.estimate for the current financial year — same
   * FY2025-26 slab logic the Tax module itself uses, so a Coach answer about tax can
   * never quote a different number than the Tax page shows. */
  async currentYearTaxEstimate(userId: string) {
    return this.tax.estimate(userId, currentFinancialYear());
  }

  // --- Structured "what does the user actually want calculated" parsing --------------

  /** Schema the composer/gateway.extract() call uses to turn a free-text
   * calculation_request question into one of the calculator's own well-typed
   * operations. Kept here (not in the gatherer) since it's part of "what can the
   * Calculator Agent actually compute", not part of retrieval. */
  static readonly calculationRequestSchema = z.object({
    operation: z.enum([
      "hypothetical_emi",
      "max_affordable_loan",
      "loan_payoff_with_extra",
      "savings_projection",
      "required_monthly_savings",
    ]),
    principal: z.number().optional(),
    annualRatePercent: z.number().optional(),
    tenureMonths: z.number().optional(),
    maxMonthlyEmi: z.number().optional(),
    extraMonthlyPayment: z.number().optional(),
    loanNameHint: z.string().optional().describe("free text the user used to refer to a specific loan, if any"),
    currentAmount: z.number().optional(),
    monthlyContribution: z.number().optional(),
    annualReturnPercent: z.number().optional(),
    months: z.number().optional(),
    targetAmount: z.number().optional(),
  });

  /** Renders any of this service's outputs into the same plain-text "facts" format
   * every other gatherer method produces, so calculation_request's output is
   * verifiable by NumericConsistencyVerifier exactly like every other advanced-path
   * answer. */
  formatEmiFacts(result: { emi: number; totalPayable: number; totalInterest: number }, input: {
    principal: number;
    annualRatePercent: number;
    tenureMonths: number;
  }): string {
    return (
      `For a loan of ${formatINR(input.principal)} at ${input.annualRatePercent}% annual interest over ` +
      `${input.tenureMonths} months: EMI would be ${formatINR(result.emi)}/month, total payable ` +
      `${formatINR(result.totalPayable)}, total interest ${formatINR(result.totalInterest)}.`
    );
  }

  formatPayoffFacts(result: {
    monthsToPayoff: number;
    interestSaved: number;
    monthsSaved: number;
    projectedPayoffDate: string;
  }, extraMonthlyPayment: number): string {
    return extraMonthlyPayment > 0
      ? `Paying an extra ${formatINR(extraMonthlyPayment)}/month would pay this loan off in ` +
          `${result.monthsToPayoff} months (${result.monthsSaved} months sooner), saving approximately ` +
          `${formatINR(result.interestSaved)} in interest. Projected payoff: ${result.projectedPayoffDate}.`
      : `At the current EMI with no extra payment, this loan pays off in ${result.monthsToPayoff} months ` +
          `(${result.projectedPayoffDate}).`;
  }

  formatSavingsProjectionFacts(
    result: { projectedValue: number; totalContributed: number; totalGrowth: number },
    input: { currentAmount: number; monthlyContribution: number; annualReturnPercent: number; months: number },
  ): string {
    return (
      `Starting from ${formatINR(input.currentAmount)}, contributing ${formatINR(input.monthlyContribution)}/month ` +
      `at an assumed ${input.annualReturnPercent}% annual return for ${input.months} months projects to ` +
      `${formatINR(result.projectedValue)} (${formatINR(result.totalContributed)} contributed, ` +
      `${formatINR(result.totalGrowth)} from growth).`
    );
  }

  formatRequiredContributionFacts(
    requiredMonthly: number,
    input: { targetAmount: number; currentAmount: number; annualReturnPercent: number; months: number },
  ): string {
    return (
      `To reach ${formatINR(input.targetAmount)} from ${formatINR(input.currentAmount)} in ${input.months} months ` +
      `at an assumed ${input.annualReturnPercent}% annual return, you would need to contribute approximately ` +
      `${formatINR(requiredMonthly)}/month.`
    );
  }

  formatMaxAffordableLoanFacts(maxPrincipal: number, input: { maxMonthlyEmi: number; annualRatePercent: number; tenureMonths: number }): string {
    return (
      `At an EMI budget of ${formatINR(input.maxMonthlyEmi)}/month, ${input.annualRatePercent}% annual interest, ` +
      `and a ${input.tenureMonths}-month tenure, the largest loan principal you could take on is approximately ` +
      `${formatINR(maxPrincipal)}.`
    );
  }

  private monthsFromNow(months: number): string {
    const date = new Date();
    date.setMonth(date.getMonth() + months);
    return date.toISOString().slice(0, 10);
  }
}
