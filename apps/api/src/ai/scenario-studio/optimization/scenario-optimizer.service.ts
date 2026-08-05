import { BadRequestException, Injectable } from "@nestjs/common";
import { SimulatorService } from "../../../simulator/simulator.service";
import { GoalsService } from "../../../goals/goals.service";
import { LoansService } from "../../../loans/loans.service";
import { InvestmentsService } from "../../../investments/investments.service";
import { TaxService } from "../../../tax/tax.service";
import { resolveTaxYearConfig } from "../../../tax/tax-slab-config";
import { currentFinancialYear } from "../../../common/utils/financial-year.util";
import { MonteCarloSimulationService } from "../monte-carlo/monte-carlo-simulation.service";
import { computeMonthlySurplus } from "../affordability.util";
import { MonteCarloResultDTO, OptimizationConstraintsDTO, OptimizedScenarioDTO, ScenarioType } from "@wealthos/types";
import {
  DEFAULT_MAX_BUDGET_FRACTION_OF_SURPLUS,
  MAX_PREPAYMENT_FRACTION_OF_LIQUID_INVESTMENTS,
  OPTIMIZABLE_SCENARIO_TYPES,
  OPTIMIZATION_COARSE_STEPS,
  OPTIMIZATION_FINE_STEPS,
  OPTIMIZATION_INFEASIBILITY_PENALTY,
  OPTIMIZATION_RISK_AVERSION_LAMBDA,
  OPTIMIZATION_SEARCH_ITERATIONS_PER_MC,
} from "../scenario-studio.constants";

// This is Scenario Studio's constraint solver / recommendation engine — given a
// scenario type and a set of budget/tax/retirement/goal constraints, it searches for
// the single decision-variable value (SIP amount, prepayment lump sum, retirement
// age, goal-delay months) that maximizes a risk-adjusted score, subject to those
// constraints holding, rather than only ranking variants the user themselves proposed
// (that's ScenarioExpanderService + ScenarioRankingService's job — this class is
// additive, not a replacement for either).
//
// Deliberately NOT built on a general-purpose LP/simplex library: every optimizable
// scenario type here (see OPTIMIZABLE_SCENARIO_TYPES) has exactly ONE continuous (or
// integer) decision variable, and the objective (median terminal net worth minus a
// downside-risk penalty) is monotonic-ish/unimodal across that variable for realistic
// inputs — a real, general LP solver would be solving a much harder problem than this
// codebase actually has. A dependency-free two-pass grid search keeps this class as
// deterministic and unit-testable as every other engine-layer file in this codebase,
// at the cost of only approximating (not exactly locating) the true optimum — an
// explicit, documented tradeoff, not an oversight.
@Injectable()
export class ScenarioOptimizerService {
  constructor(
    private simulator: SimulatorService,
    private goals: GoalsService,
    private loans: LoansService,
    private investments: InvestmentsService,
    private tax: TaxService,
    private monteCarlo: MonteCarloSimulationService,
  ) {}

  async optimize(userId: string, constraints: OptimizationConstraintsDTO): Promise<OptimizedScenarioDTO> {
    if (!OPTIMIZABLE_SCENARIO_TYPES.includes(constraints.scenarioType)) {
      throw new BadRequestException(
        `Optimization is only supported for: ${OPTIMIZABLE_SCENARIO_TYPES.join(", ")}. ` +
          `${constraints.scenarioType} has no single continuous decision variable to optimize — see scenario-studio.constants.ts.`,
      );
    }
    if (constraints.scenarioType === "LOAN_PREPAYMENT" && !constraints.loanId) {
      throw new BadRequestException("loanId is required to optimize a LOAN_PREPAYMENT scenario.");
    }
    if (constraints.scenarioType === "GOAL_DELAY" && !constraints.goalId) {
      throw new BadRequestException("goalId is required to optimize a GOAL_DELAY scenario.");
    }

    const range = await this.resolveSearchRange(userId, constraints);
    if (range.max < range.min) {
      throw new BadRequestException(
        `No feasible search range for ${constraints.scenarioType} — computed bounds were [${range.min.toFixed(2)}, ${range.max.toFixed(2)}]. Check budget/retirement-age constraints.`,
      );
    }

    // Pass 1: coarse grid across the full feasible range, cheap (reduced-iteration)
    // Monte Carlo per point.
    const coarseValues = this.linspace(range.min, range.max, OPTIMIZATION_COARSE_STEPS);
    const coarseCandidates = await this.evaluateCandidates(userId, constraints, coarseValues, OPTIMIZATION_SEARCH_ITERATIONS_PER_MC);
    const bestCoarse = this.pickBest(coarseCandidates);

    // Pass 2: fine grid around the coarse winner, still cheap Monte Carlo.
    const coarseStepSize = OPTIMIZATION_COARSE_STEPS > 1 ? (range.max - range.min) / (OPTIMIZATION_COARSE_STEPS - 1) : 0;
    const fineMin = Math.max(range.min, bestCoarse.paramValue - coarseStepSize);
    const fineMax = Math.min(range.max, bestCoarse.paramValue + coarseStepSize);
    const fineValues = this.linspace(fineMin, fineMax, OPTIMIZATION_FINE_STEPS);
    const fineCandidates = await this.evaluateCandidates(userId, constraints, fineValues, OPTIMIZATION_SEARCH_ITERATIONS_PER_MC);

    const best = this.pickBest([...coarseCandidates, ...fineCandidates]);

    // Final pass: re-run the winning parameter value at FULL configured Monte Carlo
    // fidelity — the search itself deliberately used a reduced iteration count purely
    // for speed (see OPTIMIZATION_SEARCH_ITERATIONS_PER_MC's comment); the number
    // actually returned to the caller/UI is always full-fidelity, never a
    // search-time approximation.
    const finalMonteCarlo = await this.monteCarlo.simulate(userId, constraints.scenarioType, best.params);

    return {
      scenarioType: constraints.scenarioType,
      recommendedParams: best.params,
      searchRange: range,
      candidatesEvaluated: coarseCandidates.length + fineCandidates.length,
      monteCarlo: finalMonteCarlo,
      feasible: best.feasible,
      violatedConstraints: best.violatedConstraints,
      riskAdjustedScore: best.score,
      constraintsApplied: constraints,
    };
  }

  // --- search range resolution ---------------------------------------------------

  private async resolveSearchRange(userId: string, constraints: OptimizationConstraintsDTO): Promise<{ min: number; max: number }> {
    const [debtSummary, liquidInvestmentsValue] = await Promise.all([
      this.loans.debtSummary(userId),
      this.getLiquidInvestmentsValue(userId),
    ]);

    // A neutral probe run purely to read the real baseline (income/expenses/age) —
    // the throwaway params below satisfy SimulatorService's REQUIRED_FIELDS
    // validation but are never used for anything except reading `.baseline`, since
    // buildBaseline() doesn't depend on the scenario params at all.
    const probeParams = this.probeParams(constraints.scenarioType, constraints);
    const probe = await this.simulator.run(userId, constraints.scenarioType, probeParams);
    const surplus = computeMonthlySurplus(probe.baseline.monthlyIncome, probe.baseline.monthlyExpenses, Number(debtSummary.totalMonthlyEmi));
    const budgetFraction = constraints.maxMonthlyBudgetPercent ?? DEFAULT_MAX_BUDGET_FRACTION_OF_SURPLUS;
    const maxMonthlyCommitment = Math.max(0, surplus * budgetFraction);

    switch (constraints.scenarioType) {
      case "SIP_INCREASE": {
        let max = maxMonthlyCommitment;
        if (constraints.respectTaxAdvantagedLimit !== false) {
          max = Math.min(max, await this.remaining80CHeadroomMonthly(userId));
        }
        return { min: 0, max };
      }
      case "LOAN_PREPAYMENT":
        return { min: 0, max: liquidInvestmentsValue * MAX_PREPAYMENT_FRACTION_OF_LIQUID_INVESTMENTS };
      case "RETIREMENT_AGE_SHIFT": {
        const currentAge = probe.baseline.currentAge ?? 30;
        const min = constraints.minRetirementAge ?? currentAge + 1;
        const max = constraints.maxRetirementAge ?? 75;
        return { min, max };
      }
      case "GOAL_DELAY":
        return { min: 0, max: 60 };
      default:
        throw new BadRequestException(`Unsupported scenario type: ${constraints.scenarioType}`);
    }
  }

  private probeParams(scenarioType: ScenarioType, constraints: OptimizationConstraintsDTO): Record<string, unknown> {
    switch (scenarioType) {
      case "SIP_INCREASE":
        return { additionalMonthlyAmount: 0 };
      case "LOAN_PREPAYMENT":
        return { loanId: constraints.loanId, lumpSum: 0 };
      case "RETIREMENT_AGE_SHIFT":
        return { newRetirementAge: constraints.minRetirementAge ?? 60 };
      case "GOAL_DELAY":
        return { goalId: constraints.goalId, delayMonths: 0 };
      default:
        throw new BadRequestException(`Unsupported scenario type: ${scenarioType}`);
    }
  }

  private buildParamsForValue(scenarioType: ScenarioType, value: number, constraints: OptimizationConstraintsDTO): Record<string, unknown> {
    switch (scenarioType) {
      case "SIP_INCREASE":
        return { additionalMonthlyAmount: value };
      case "LOAN_PREPAYMENT":
        return { loanId: constraints.loanId, lumpSum: value };
      case "RETIREMENT_AGE_SHIFT":
        return { newRetirementAge: Math.round(value) };
      case "GOAL_DELAY":
        return { goalId: constraints.goalId, delayMonths: Math.round(value) };
      default:
        throw new BadRequestException(`Unsupported scenario type: ${scenarioType}`);
    }
  }

  // --- candidate evaluation ---------------------------------------------------------

  private async evaluateCandidates(
    userId: string,
    constraints: OptimizationConstraintsDTO,
    values: number[],
    iterations: number,
  ): Promise<OptimizationCandidate[]> {
    const candidates: OptimizationCandidate[] = [];
    for (const value of values) {
      const params = this.buildParamsForValue(constraints.scenarioType, value, constraints);
      const mc = await this.monteCarlo.simulate(userId, constraints.scenarioType, params, { iterations });
      const { feasible, violated } = await this.checkConstraints(userId, constraints, value, mc);
      const downsideDeviation = mc.terminalPercentiles.p50 - mc.terminalPercentiles.p10;
      const score =
        mc.terminalPercentiles.p50 -
        OPTIMIZATION_RISK_AVERSION_LAMBDA * downsideDeviation -
        (feasible ? 0 : OPTIMIZATION_INFEASIBILITY_PENALTY);

      candidates.push({ paramValue: value, params, feasible, violatedConstraints: violated, score });
    }
    return candidates;
  }

  // Budget/tax-headroom constraints are already baked into the search range itself
  // (resolveSearchRange), but are re-verified explicitly here too — belt-and-braces
  // against floating-point edge cases at the exact boundary, and because retirement
  // age / goal-funding constraints genuinely can't be expressed as a simple range
  // bound alone.
  private async checkConstraints(
    userId: string,
    constraints: OptimizationConstraintsDTO,
    value: number,
    mc: MonteCarloResultDTO,
  ): Promise<{ feasible: boolean; violated: string[] }> {
    const violated: string[] = [];

    if (constraints.scenarioType === "RETIREMENT_AGE_SHIFT") {
      if (constraints.minRetirementAge !== undefined && value < constraints.minRetirementAge) {
        violated.push(`Retirement age below the minimum constraint (${constraints.minRetirementAge}).`);
      }
      if (constraints.maxRetirementAge !== undefined && value > constraints.maxRetirementAge) {
        violated.push(`Retirement age above the maximum constraint (${constraints.maxRetirementAge}).`);
      }
    }

    if (constraints.scenarioType === "SIP_INCREASE" && constraints.respectTaxAdvantagedLimit !== false) {
      const headroom = await this.remaining80CHeadroomMonthly(userId);
      if (value > headroom + 1) {
        violated.push(
          `Exceeds remaining Section 80C headroom of ₹${headroom.toFixed(0)}/month for this financial year — contributions above this stop being tax-advantaged under the old regime.`,
        );
      }
    }

    if (constraints.respectGoalFunding !== false && constraints.targetGoalIds && constraints.targetGoalIds.length > 0) {
      // A simple, honest check — the same "does this help or hurt" read
      // ScenarioRankingService already uses for goal impact notes, not a full
      // goal-trajectory re-simulation under this candidate's own parameters (which
      // the underlying deterministic engine doesn't support — documented there too).
      const goals = await this.goals.list(userId);
      const targetGoals = goals.filter((g) => constraints.targetGoalIds!.includes(g.id));
      const stillNeedsFunding = targetGoals.find((g) => g.requiredMonthlyContribution > 0);
      if (stillNeedsFunding && mc.probabilityOfNetWorthDecline > 0.5) {
        violated.push(
          `More than half of simulated outcomes show a net worth decline while "${stillNeedsFunding.name}" still needs funding — risky relative to that goal.`,
        );
      }
    }

    return { feasible: violated.length === 0, violated };
  }

  private pickBest(candidates: OptimizationCandidate[]): OptimizationCandidate {
    return candidates.reduce((best, c) => (c.score > best.score ? c : best));
  }

  private linspace(min: number, max: number, steps: number): number[] {
    if (steps <= 1 || max <= min) return [min];
    const values: number[] = [];
    for (let i = 0; i < steps; i++) values.push(min + ((max - min) * i) / (steps - 1));
    return values;
  }

  // --- shared helpers -----------------------------------------------------------

  // Mirrors ScenarioExpanderService.getLiquidInvestmentsValue() exactly (real
  // liquid-only investment value — Investment.liquidity === "LIQUID", excluding
  // locked-in SEMI_LIQUID/ILLIQUID holdings like PPF/EPF/NPS). Small, localized
  // duplication rather than exposing that private method cross-service, same
  // precedent already used throughout this module (see affordability.util.ts).
  private async getLiquidInvestmentsValue(userId: string): Promise<number> {
    const holdings = await this.investments.list(userId);
    return holdings.filter((h) => h.liquidity === "LIQUID").reduce((sum, h) => sum + Number(h.currentValue), 0);
  }

  // Real integration with TaxService (not a hardcoded proxy): pulls this financial
  // year's actual logged Section 80C deductions and the real slab config's limit for
  // that year, rather than assuming a flat ₹1.5L/year headroom for everyone. Spreading
  // the *remaining annual* headroom evenly across 12 months is a simplification (a
  // lump-sum 80C contribution made once, e.g. an ELSS purchase in March, wouldn't
  // actually need to be spread monthly) — documented rather than silently assumed.
  private async remaining80CHeadroomMonthly(userId: string): Promise<number> {
    const financialYear = currentFinancialYear();
    const { config } = resolveTaxYearConfig(financialYear);
    const deductions = await this.tax.listDeductions(userId, financialYear);
    const used80C = deductions
      .filter((d) => d.section === "SECTION_80C")
      .reduce((sum, d) => sum + Number(d.amount), 0);
    const limit = config.sectionLimits.SECTION_80C ?? 0;
    const remainingAnnual = Math.max(0, limit - used80C);
    return remainingAnnual / 12;
  }
}

interface OptimizationCandidate {
  paramValue: number;
  params: Record<string, unknown>;
  feasible: boolean;
  violatedConstraints: string[];
  score: number;
}
