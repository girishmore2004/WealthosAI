import { Injectable, BadRequestException } from "@nestjs/common";
import { SimulatorService } from "../../../simulator/simulator.service";
import { calculateEmi } from "../../../simulator/simulator.engine";
import {
  MonteCarloConfigDTO,
  MonteCarloResultDTO,
  MonteCarloRiskLevel,
  RunScenarioResponseDTO,
  ScenarioParamsByType,
  ScenarioType,
} from "@wealthos/types";
import {
  DEFAULT_MC_ASSUMPTIONS,
  DEFAULT_MC_ITERATIONS,
  MAX_MC_ITERATIONS,
  MC_HORIZON_MONTHS_CAP,
  MIN_MC_ITERATIONS,
  RISK_LEVEL_COV_THRESHOLDS,
} from "../scenario-studio.constants";
import {
  MonteCarloAssumptions,
  MonteCarloScenarioEffect,
  MonteCarloTimeoutError,
  computePercentileSet,
  runMonteCarloSimulation,
} from "./monte-carlo.engine";

// (Impure) orchestrator layer: gathers real baseline numbers via SimulatorService
// (the same audited baseline every other Scenario Studio sub-service uses — see
// affordability.util.ts / scenario-expander.service.ts for the established pattern of
// "one real baseline fetch, every downstream computation is pure over it"), derives
// the scenario's cashflow/loan effect, then hands both to the pure
// runMonteCarloSimulation() engine. This class does no randomness or arithmetic of its
// own beyond simple aggregation (percentiles, mean/stddev) — the actual simulation
// loop lives entirely in monte-carlo.engine.ts so it stays independently unit-testable.
@Injectable()
export class MonteCarloSimulationService {
  constructor(private simulator: SimulatorService) {}

  /**
   * @param goalTargetAmount Optional — when supplied, `probabilityOfGoalShortfall` in
   * the result is the fraction of simulated trajectories whose terminal net worth
   * falls short of this target. Omitted (null) when not supplied, since "not measured"
   * and "measured at 0%" are meaningfully different (same distinction AiResult makes
   * for groundingScore vs. hallucinationRisk in ai-gateway.types.ts).
   */
  async simulate(
    userId: string,
    scenarioType: ScenarioType,
    params: Record<string, unknown>,
    overrides: Partial<MonteCarloConfigDTO> = {},
    goalTargetAmount?: number,
  ): Promise<MonteCarloResultDTO> {
    // SimulatorService.run() both validates params (REQUIRED_FIELDS — the same 400
    // callers of /simulator/run and Scenario Studio's build() already get for a
    // missing/wrong-shaped field) and gathers the real baseline in one call, so this
    // service never duplicates that DB-gathering logic.
    const baseRun = await this.simulator.run(userId, scenarioType, params);
    const effect = this.deriveEffect(scenarioType, params, baseRun);

    const iterations = Math.min(
      MAX_MC_ITERATIONS,
      Math.max(MIN_MC_ITERATIONS, overrides.iterations ?? DEFAULT_MC_ITERATIONS),
    );
    const horizonYears = overrides.horizonYears ?? this.defaultHorizonYears(scenarioType, baseRun);
    const horizonMonths = Math.min(MC_HORIZON_MONTHS_CAP, Math.max(12, Math.round(horizonYears * 12)));
    const seed = overrides.seed ?? this.deterministicSeedFrom(userId, scenarioType, params);

    const assumptions: MonteCarloAssumptions = {
      annualReturnMeanPercent: overrides.annualReturnMeanPercent ?? DEFAULT_MC_ASSUMPTIONS.annualReturnMeanPercent,
      annualReturnStdDevPercent: overrides.annualReturnStdDevPercent ?? DEFAULT_MC_ASSUMPTIONS.annualReturnStdDevPercent,
      expenseInflationMeanPercent: overrides.expenseInflationMeanPercent ?? DEFAULT_MC_ASSUMPTIONS.expenseInflationMeanPercent,
      expenseInflationStdDevPercent:
        overrides.expenseInflationStdDevPercent ?? DEFAULT_MC_ASSUMPTIONS.expenseInflationStdDevPercent,
      incomeGrowthMeanPercent: overrides.incomeGrowthMeanPercent ?? DEFAULT_MC_ASSUMPTIONS.incomeGrowthMeanPercent,
      incomeGrowthStdDevPercent: overrides.incomeGrowthStdDevPercent ?? DEFAULT_MC_ASSUMPTIONS.incomeGrowthStdDevPercent,
      propertyAppreciationMeanPercent:
        overrides.propertyAppreciationMeanPercent ?? DEFAULT_MC_ASSUMPTIONS.propertyAppreciationMeanPercent,
      propertyAppreciationStdDevPercent:
        overrides.propertyAppreciationStdDevPercent ?? DEFAULT_MC_ASSUMPTIONS.propertyAppreciationStdDevPercent,
    };

    const raw = this.runBounded(scenarioType, horizonMonths, iterations, seed, assumptions, effect);
    const terminalPercentiles = computePercentileSet(raw.terminalNetWorths);

    const mean = raw.terminalNetWorths.reduce((s, v) => s + v, 0) / raw.terminalNetWorths.length;
    const variance = raw.terminalNetWorths.reduce((s, v) => s + (v - mean) ** 2, 0) / raw.terminalNetWorths.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean !== 0 ? Math.abs(stdDev / mean) : 0;

    const currentNetWorth = baseRun.baseline.netWorth;
    const declineCount = raw.terminalNetWorths.filter((v) => v < currentNetWorth).length;
    const probabilityOfNetWorthDecline = declineCount / raw.terminalNetWorths.length;

    const probabilityOfGoalShortfall =
      goalTargetAmount !== undefined
        ? raw.terminalNetWorths.filter((v) => v < goalTargetAmount).length / raw.terminalNetWorths.length
        : null;

    const config: MonteCarloConfigDTO = { iterations, horizonYears: horizonMonths / 12, seed, ...assumptions };

    return {
      scenarioType,
      iterations,
      horizonYears: horizonMonths / 12,
      terminalPercentiles,
      probabilityOfNetWorthDecline,
      probabilityOfGoalShortfall,
      riskLevel: this.classifyRisk(coefficientOfVariation),
      coefficientOfVariation,
      yearlyBands: raw.yearlyBands,
      assumptions: this.describeAssumptions(assumptions, horizonMonths / 12, iterations),
      config,
    };
  }

  // NEW (audit item #17): wraps runMonteCarloSimulation() to translate its
  // MonteCarloTimeoutError (a wall-clock circuit breaker — see that error's own doc
  // comment) into a clear, actionable BadRequestException instead of letting the raw
  // engine error surface as an unhandled 500. This is genuinely expected to be rare in
  // practice — iterations/horizonMonths are already clamped by MAX_MC_ITERATIONS/
  // MC_HORIZON_MONTHS_CAP to values that comfortably finish well under the default
  // time budget on a normal host — but a clear, typed failure path beats an unbounded
  // hang if it ever does happen (an unusually slow/loaded host, for instance).
  private runBounded(
    scenarioType: ScenarioType,
    horizonMonths: number,
    iterations: number,
    seed: number,
    assumptions: MonteCarloAssumptions,
    effect: MonteCarloScenarioEffect,
  ) {
    try {
      return runMonteCarloSimulation({ scenarioType, horizonMonths, iterations, seed, assumptions, effect });
    } catch (err) {
      if (err instanceof MonteCarloTimeoutError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  private classifyRisk(coefficientOfVariation: number): MonteCarloRiskLevel {
    if (coefficientOfVariation < RISK_LEVEL_COV_THRESHOLDS.low) return "LOW";
    if (coefficientOfVariation < RISK_LEVEL_COV_THRESHOLDS.medium) return "MEDIUM";
    return "HIGH";
  }

  private defaultHorizonYears(scenarioType: ScenarioType, baseRun: RunScenarioResponseDTO): number {
    if (scenarioType === "RETIREMENT_AGE_SHIFT") {
      const currentAge = baseRun.baseline.currentAge ?? 30;
      return Math.max(1, baseRun.baseline.targetRetirementAge - currentAge);
    }
    return 5; // matches PROJECTION_YEARS in simulator.engine.ts for every other scenario type
  }

  // A stable (non-time-based) hash of the inputs that determine the simulation, so
  // repeated calls with identical arguments reproduce identical percentile output —
  // load-bearing for this service's own unit tests and for "why did this number
  // change" debugging. Callers who explicitly want a fresh random draw each time can
  // still pass their own `seed` override.
  private deterministicSeedFrom(userId: string, scenarioType: ScenarioType, params: Record<string, unknown>): number {
    const str = `${userId}:${scenarioType}:${JSON.stringify(params)}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash >>> 0;
  }

  private describeAssumptions(assumptions: MonteCarloAssumptions, horizonYears: number, iterations: number): string[] {
    const lines = [
      `${iterations.toLocaleString("en-IN")} simulated trajectories over a ${horizonYears.toFixed(1)}-year horizon`,
      `Annual investment return sampled from a normal distribution: mean ${assumptions.annualReturnMeanPercent}%, std-dev ${assumptions.annualReturnStdDevPercent}%, resampled once per simulated year (captures sequence-of-returns risk, not just a single flat rate)`,
      `Monthly expenses inflate at a sampled annual rate: mean ${assumptions.expenseInflationMeanPercent}%, std-dev ${assumptions.expenseInflationStdDevPercent}%`,
      `Monthly income grows at a sampled annual rate: mean ${assumptions.incomeGrowthMeanPercent}%, std-dev ${assumptions.incomeGrowthStdDevPercent}% (independent of any one-time scenario effect, e.g. a salary-hike scenario's own percentage)`,
      "Existing (and any scenario-added) loans amortize month-by-month at their real, non-stochastic rate and EMI",
      "Distribution means are not fitted to this specific user's actual portfolio mix, career trajectory, or regional property market — see DEFAULT_MC_ASSUMPTIONS in scenario-studio.constants.ts for the documented simplification",
    ];
    return lines;
  }

  // Reconstructs the scenario's cashflow/loan/property effect for the Monte Carlo
  // engine. Deliberately parallels (but does not import) simulator.engine.ts's
  // runScenario() switch — that function also builds a narrative string and a
  // baseline-vs-scenario delta this module doesn't need, and its shape isn't meant
  // for stochastic per-month resampling. Small, localized duplication of the *effect*
  // math only (income/expense/investment/loan deltas), not the projection math itself
  // (which lives solely in monte-carlo.engine.ts).
  private deriveEffect(
    scenarioType: ScenarioType,
    params: Record<string, unknown>,
    baseRun: RunScenarioResponseDTO,
  ): MonteCarloScenarioEffect {
    const baseline = baseRun.baseline;
    const loans = baseline.loans ?? [];
    const base: MonteCarloScenarioEffect = {
      monthlyIncome: baseline.monthlyIncome,
      monthlyExpenses: baseline.monthlyExpenses,
      monthlyInvestmentContribution: 0,
      investmentsValue: baseline.investmentsValue,
      loans,
      immediateNetWorthDelta: 0,
    };

    switch (scenarioType) {
      case "SALARY_HIKE": {
        const p = params as ScenarioParamsByType["SALARY_HIKE"];
        return { ...base, monthlyIncome: baseline.monthlyIncome * (1 + p.percentIncrease / 100) };
      }
      case "SALARY_DROP": {
        const p = params as ScenarioParamsByType["SALARY_DROP"];
        return { ...base, monthlyIncome: Math.max(0, baseline.monthlyIncome * (1 - p.percentDecrease / 100)) };
      }
      case "SIP_INCREASE": {
        const p = params as ScenarioParamsByType["SIP_INCREASE"];
        return { ...base, monthlyInvestmentContribution: p.additionalMonthlyAmount };
      }
      case "SIP_DECREASE": {
        // Same modeling choice as the deterministic engine: the reduced amount sits
        // idle instead of being invested (0 extra contribution). Unlike
        // simulator.engine.ts's runScenario() (which compares this against a
        // baseline that KEEPS investing it), this Monte Carlo simulation reports the
        // absolute distribution of the scenario trajectory itself, not a delta —
        // comparing two full distributions against each other is a documented future
        // enhancement (see README "Phase 15"), not implemented today.
        return { ...base, monthlyInvestmentContribution: 0 };
      }
      case "HOUSE_PURCHASE": {
        const p = params as ScenarioParamsByType["HOUSE_PURCHASE"];
        const downPayment = p.propertyValue * (p.downPaymentPercent / 100);
        const loanPrincipal = p.propertyValue - downPayment;
        const emi = calculateEmi(loanPrincipal, p.loanInterestRateAnnual, p.loanTenureMonths);
        const newLoan = {
          id: "__house_purchase_new_loan__",
          principal: loanPrincipal,
          annualRatePercent: p.loanInterestRateAnnual,
          emi,
        };
        return {
          ...base,
          loans: [...loans, newLoan],
          propertyValue: p.propertyValue,
        };
      }
      case "LOAN_PREPAYMENT": {
        const p = params as ScenarioParamsByType["LOAN_PREPAYMENT"];
        const scenarioLoans = loans.map((l) =>
          l.id === p.loanId ? { ...l, principal: Math.max(0, l.principal - p.lumpSum) } : l,
        );
        return { ...base, loans: scenarioLoans, immediateNetWorthDelta: -p.lumpSum };
      }
      case "RETIREMENT_AGE_SHIFT": {
        // No direct cashflow/loan effect — the horizon itself (years to the target
        // retirement age) is what varies; simulate() resolves that via
        // defaultHorizonYears()/the caller's `horizonYears` override.
        return base;
      }
      case "EMERGENCY_EXPENSE": {
        const p = params as ScenarioParamsByType["EMERGENCY_EXPENSE"];
        return { ...base, immediateNetWorthDelta: -p.amount };
      }
      case "GOAL_DELAY": {
        // Delaying a goal's target date doesn't move money by itself — matches
        // simulator.engine.ts's own documented behavior for this scenario type.
        return base;
      }
      case "NEW_LOAN": {
        // Same modeling choice as simulator.engine.ts's deterministic NEW_LOAN case:
        // immediateNetWorthDelta stays 0 (base) — the borrowed amount is assumed
        // spent/deployed immediately on something not tracked as an ongoing asset, so
        // only the new loan's amortization (via `loans`) and its EMI's drag on monthly
        // cashflow show up in the simulated trajectory.
        const p = params as ScenarioParamsByType["NEW_LOAN"];
        const emi = calculateEmi(p.loanAmount, p.annualRatePercent, p.tenureMonths);
        const newLoan = {
          id: "__new_loan__",
          principal: p.loanAmount,
          annualRatePercent: p.annualRatePercent,
          emi,
        };
        return { ...base, loans: [...loans, newLoan] };
      }
      default: {
        const _exhaustive: never = scenarioType;
        throw new BadRequestException(`Unsupported scenario type for Monte Carlo simulation: ${String(_exhaustive)}`);
      }
    }
  }
}
