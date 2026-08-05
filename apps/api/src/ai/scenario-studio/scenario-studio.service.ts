import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ScenarioPromptParserService } from "./parsing/scenario-prompt-parser.service";
import { ScenarioExpanderService, ScenarioVariant } from "./expansion/scenario-expander.service";
import { SensitivityAnalysisService, SensitivityDimension } from "./sensitivity/sensitivity-analysis.service";
import { ScenarioRankingService, RankedVariant } from "./ranking/scenario-ranking.service";
import { ScenarioExplainerService } from "./explanation/scenario-explainer.service";
import { MonteCarloSimulationService } from "./monte-carlo/monte-carlo-simulation.service";
import { ScenarioOptimizerService } from "./optimization/scenario-optimizer.service";
import { BUILD_MC_PREVIEW_ITERATIONS } from "./scenario-studio.constants";
import { SimulateScenarioStudioDto } from "./dto/simulate-scenario-studio.dto";
import { OptimizeScenarioStudioDto } from "./dto/optimize-scenario-studio.dto";
import { MonteCarloResultDTO, OptimizedScenarioDTO, ScenarioType } from "@wealthos/types";

export interface ScenarioStudioResult {
  prompt: string;
  understood: boolean;
  scenarioType: ScenarioType | null;
  baseParams: Record<string, unknown>;
  variants: ScenarioVariant[];
  sensitivity: SensitivityDimension[];
  ranked: RankedVariant[];
  explanation: string;
  explanationConfidence: number;
  verificationPassed: boolean;
  // Fast, reduced-fidelity Monte Carlo preview of the ranked winner's parameters —
  // see tryMonteCarloSummary()'s comment for why this never blocks the rest of the
  // (already-deterministic) result from being returned.
  monteCarloSummary: MonteCarloResultDTO | null;
}

export interface ScenarioStudioSimulationResult {
  result: MonteCarloResultDTO;
  explanation: string;
  explanationConfidence: number;
  verificationPassed: boolean;
}

export interface ScenarioStudioOptimizationResult extends OptimizedScenarioDTO {
  explanation: string;
  explanationConfidence: number;
  verificationPassed: boolean;
}

@Injectable()
export class ScenarioStudioService {
  private readonly logger = new Logger(ScenarioStudioService.name);

  constructor(
    private prisma: PrismaService,
    private parser: ScenarioPromptParserService,
    private expander: ScenarioExpanderService,
    private sensitivity: SensitivityAnalysisService,
    private ranking: ScenarioRankingService,
    private explainer: ScenarioExplainerService,
    private monteCarlo: MonteCarloSimulationService,
    private optimizer: ScenarioOptimizerService,
  ) {}

  async build(userId: string, prompt: string, targetGoalIds: string[] = []): Promise<ScenarioStudioResult> {
    const parsed = await this.parser.parse(userId, prompt);

    if (!parsed.understood || !parsed.scenarioType) {
      return {
        prompt,
        understood: false,
        scenarioType: null,
        baseParams: {},
        variants: [],
        sensitivity: [],
        ranked: [],
        explanation:
          "I couldn't match this to one of the supported scenario types (salary change, SIP change, house purchase, loan prepayment, retirement age shift, emergency expense, or goal delay). Try rephrasing with a specific number, e.g. \"what if I increase my SIP by ₹5,000/month\".",
        explanationConfidence: 1,
        verificationPassed: true,
        monteCarloSummary: null,
      };
    }

    // SimulatorService.run() (called inside the expander) is the same validation
    // used by the existing /simulator/run endpoint — a missing/wrong-shaped field
    // throws a clear BadRequestException here rather than silently proceeding, same
    // as it always has for that endpoint.
    let variants: ScenarioVariant[];
    try {
      variants = await this.expander.expand(userId, parsed.scenarioType, parsed.params);
    } catch (err) {
      if (err instanceof BadRequestException) {
        return {
          prompt,
          understood: true,
          scenarioType: parsed.scenarioType,
          baseParams: parsed.params,
          variants: [],
          sensitivity: [],
          ranked: [],
          explanation: `I understood this as a ${parsed.scenarioType} scenario, but couldn't extract enough detail from your prompt: ${err.message}. Try including the specific number.`,
          explanationConfidence: 1,
          verificationPassed: true,
          monteCarloSummary: null,
        };
      }
      throw err;
    }

    const baseVariant = variants.find((v) => v.label === "base")!;
    const [sensitivityDimensions, ranked] = await Promise.all([
      this.sensitivity.analyze(userId, parsed.scenarioType, parsed.params, baseVariant.run),
      this.ranking.rank(userId, variants, targetGoalIds),
    ]);

    const explanation = await this.explainer.explain(userId, parsed.scenarioType, variants, ranked);

    // A fast probabilistic preview of the RANKED WINNER's params, attached alongside
    // the deterministic 4-variant result rather than replacing it — build() already
    // does up to ~10 deterministic SimulatorService.run() calls plus 2 AI gateway
    // calls per the controller's own rate-limit comment, so this preview
    // deliberately uses a reduced iteration count (BUILD_MC_PREVIEW_ITERATIONS) and
    // never blocks the response if it fails. Callers wanting full-fidelity
    // percentiles/bands should call POST /scenario-studio/simulate directly.
    const topVariant = variants.find((v) => v.label === ranked[0].label)!;
    const monteCarloSummary = await this.tryMonteCarloSummary(userId, parsed.scenarioType, topVariant.params);

    const result: ScenarioStudioResult = {
      prompt,
      understood: true,
      scenarioType: parsed.scenarioType,
      baseParams: parsed.params,
      variants,
      sensitivity: sensitivityDimensions,
      ranked,
      explanation: explanation.text,
      explanationConfidence: explanation.confidence,
      verificationPassed: explanation.verificationPassed,
      monteCarloSummary,
    };

    await this.logRun(userId, result, targetGoalIds);
    return result;
  }

  /**
   * Probabilistic planning: runs a Monte Carlo simulation for a single scenario type
   * + params (no variant expansion, no ranking — this is the dedicated full-fidelity
   * probabilistic endpoint, distinct from build()'s lightweight preview above) and
   * grounds an LLM explanation in the resulting percentiles via the AI Gateway.
   */
  async simulate(userId: string, dto: SimulateScenarioStudioDto): Promise<ScenarioStudioSimulationResult> {
    const { scenarioType, params, ...overrides } = dto;
    const result = await this.monteCarlo.simulate(userId, scenarioType, params, overrides);
    const explanation = await this.explainer.explainProbabilistic(userId, scenarioType, result);

    await this.logMonteCarloRun(userId, scenarioType, params, result, explanation);

    return {
      result,
      explanation: explanation.text,
      explanationConfidence: explanation.confidence,
      verificationPassed: explanation.verificationPassed,
    };
  }

  /**
   * Constraint-solving recommendation: searches for the scenario parameter value
   * (SIP amount, prepayment lump sum, retirement age, or goal-delay length) that
   * maximizes a risk-adjusted Monte Carlo outcome subject to the caller's
   * budget/tax/retirement/goal constraints — see ScenarioOptimizerService for the
   * search algorithm and OPTIMIZABLE_SCENARIO_TYPES for which scenario types
   * support this.
   */
  async optimize(userId: string, dto: OptimizeScenarioStudioDto): Promise<ScenarioStudioOptimizationResult> {
    const result = await this.optimizer.optimize(userId, dto);
    const explanation = await this.explainer.explainOptimization(userId, result);

    await this.logOptimizationRun(userId, result, explanation);

    return {
      ...result,
      explanation: explanation.text,
      explanationConfidence: explanation.confidence,
      verificationPassed: explanation.verificationPassed,
    };
  }

  private async tryMonteCarloSummary(
    userId: string,
    scenarioType: ScenarioType,
    params: Record<string, unknown>,
  ): Promise<MonteCarloResultDTO | null> {
    try {
      return await this.monteCarlo.simulate(userId, scenarioType, params, { iterations: BUILD_MC_PREVIEW_ITERATIONS });
    } catch (err) {
      // Never lets a probabilistic-preview failure take down the deterministic
      // build() response it's attached to — same fail-open philosophy every logging
      // call in this codebase's AI layer already follows (see logRun() below).
      this.logger.warn(`Monte Carlo preview failed for ${scenarioType}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async logRun(userId: string, result: ScenarioStudioResult, targetGoalIds: string[]): Promise<void> {
    try {
      await this.prisma.client.scenarioStudioRun.create({
        data: {
          userId,
          prompt: result.prompt,
          scenarioType: result.scenarioType ?? "UNKNOWN",
          baseParams: result.baseParams as object,
          targetGoalIds,
          variants: result.variants.map((v) => ({
            label: v.label,
            params: v.params,
            netWorthDeltaIn5Years: v.run.result.netWorthDeltaIn5Years,
            projectedNetWorthIn5Years: v.run.result.projectedNetWorthIn5Years,
            monthlyCashflowDelta: v.run.result.monthlyCashflowDelta,
            feasible: v.feasible,
            feasibilityNote: v.feasibilityNote,
          })) as object,
          sensitivity: result.sensitivity as object,
          rankedOrder: result.ranked.map((r) => r.label),
          explanation: result.explanation,
          explanationConfidence: result.explanationConfidence,
          verificationPassed: result.verificationPassed,
          monteCarloSummary: (result.monteCarloSummary as object) ?? undefined,
        },
      });
    } catch {
      // Same reasoning as every other logging call in this codebase's AI layer: a
      // logging failure must never fail the actual result being returned.
    }
  }

  private async logMonteCarloRun(
    userId: string,
    scenarioType: ScenarioType,
    params: Record<string, unknown>,
    result: MonteCarloResultDTO,
    explanation: { text: string; confidence: number; verificationPassed: boolean },
  ): Promise<void> {
    try {
      await this.prisma.client.scenarioMonteCarloRun.create({
        data: {
          userId,
          scenarioType,
          params: params as object,
          config: result.config as object,
          terminalPercentiles: result.terminalPercentiles as object,
          probabilityOfNetWorthDecline: result.probabilityOfNetWorthDecline,
          riskLevel: result.riskLevel,
          coefficientOfVariation: result.coefficientOfVariation,
          explanation: explanation.text,
          explanationConfidence: explanation.confidence,
          verificationPassed: explanation.verificationPassed,
        },
      });
    } catch {
      // Fail-open, same as logRun() above.
    }
  }

  private async logOptimizationRun(
    userId: string,
    result: OptimizedScenarioDTO,
    explanation: { text: string; confidence: number; verificationPassed: boolean },
  ): Promise<void> {
    try {
      await this.prisma.client.scenarioOptimizationRun.create({
        data: {
          userId,
          scenarioType: result.scenarioType,
          constraints: result.constraintsApplied as object,
          recommendedParams: result.recommendedParams as object,
          searchRange: result.searchRange as object,
          candidatesEvaluated: result.candidatesEvaluated,
          feasible: result.feasible,
          violatedConstraints: result.violatedConstraints,
          riskAdjustedScore: result.riskAdjustedScore,
          explanation: explanation.text,
          explanationConfidence: explanation.confidence,
          verificationPassed: explanation.verificationPassed,
        },
      });
    } catch {
      // Fail-open, same as logRun() above.
    }
  }

  async history(userId: string, take = 20) {
    return this.prisma.client.scenarioStudioRun.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
    });
  }

  async monteCarloHistory(userId: string, take = 20) {
    return this.prisma.client.scenarioMonteCarloRun.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
    });
  }

  async optimizationHistory(userId: string, take = 20) {
    return this.prisma.client.scenarioOptimizationRun.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
    });
  }
}
