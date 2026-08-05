import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { NumericConsistencyVerifier } from "../../coach/verification/numeric-consistency.verifier";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { ScenarioVariant } from "../expansion/scenario-expander.service";
import { RankedVariant } from "../ranking/scenario-ranking.service";
import { MonteCarloResultDTO, OptimizedScenarioDTO, ScenarioType } from "@wealthos/types";

const explainSchema = z.object({ explanation: z.string() });

export interface ExplanationResult {
  text: string;
  confidence: number;
  verificationPassed: boolean;
}

@Injectable()
export class ScenarioExplainerService {
  private readonly logger = new Logger(ScenarioExplainerService.name);

  constructor(
    private gateway: AiGatewayService,
    private verifier: NumericConsistencyVerifier,
  ) {}

  async explain(userId: string, scenarioType: string, variants: ScenarioVariant[], ranked: RankedVariant[]): Promise<ExplanationResult> {
    const factsText = this.buildFactsText(scenarioType, variants, ranked);

    try {
      const result = await this.gateway.extract(
        `Facts about a set of ${scenarioType} scenario variants (use ONLY these numbers):\n${factsText}\n\n` +
          "Explain in 2-4 sentences which variable(s) drove the difference in outcome between the variants, " +
          "and why the top-ranked variant came out on top. Do not introduce any number not already given.",
        explainSchema,
        { feature: "scenario_studio.explain", promptName: "scenario_studio.explain", userId, cacheable: false },
      );

      const verification = this.verifier.verify(result.data.explanation, factsText);
      if (verification.passed) {
        return { text: result.data.explanation, confidence: result.confidence, verificationPassed: true };
      }

      this.logger.warn(`Scenario explanation failed numeric verification (unmatched: ${verification.unmatchedNumbers.join(", ")}) — falling back to facts summary.`);
      return { text: factsText, confidence: 0.5, verificationPassed: false };
    } catch (err) {
      if (err instanceof AiUnavailableException) {
        this.logger.warn(`Scenario explanation unavailable: ${err.message}`);
        return { text: factsText, confidence: 0.5, verificationPassed: false };
      }
      throw err;
    }
  }

  private buildFactsText(scenarioType: string, variants: ScenarioVariant[], ranked: RankedVariant[]): string {
    const variantLines = variants
      .map((v) => {
        const r = ranked.find((rk) => rk.label === v.label)!;
        return `${v.label}: ${scenarioType} param = ${JSON.stringify(v.params)}, net worth change in 5 years = ₹${r.netWorthDeltaIn5Years.toFixed(0)}, feasible = ${r.feasible ? "yes" : "no"} (${r.feasibilityNote})`;
      })
      .join("\n");

    const topRanked = ranked[0];
    return `${variantLines}\n\nRanked first: "${topRanked.label}" with a score of ₹${topRanked.score.toFixed(0)}.`;
  }

  /**
   * Explains a Monte Carlo probabilistic simulation result — the range of likely
   * outcomes, the risk level, and what the uncertainty band means — grounded ONLY in
   * the numbers the simulation actually produced. Same gateway call shape, same
   * NumericConsistencyVerifier guardrail, and same AiUnavailableException fallback
   * pattern as explain() above; this is a distinct method (not an overload) because
   * the facts text and prompt framing are meaningfully different for a probability
   * distribution versus a set of four named variants.
   */
  async explainProbabilistic(userId: string, scenarioType: ScenarioType, result: MonteCarloResultDTO): Promise<ExplanationResult> {
    const factsText = this.buildProbabilisticFactsText(scenarioType, result);

    try {
      const gatewayResult = await this.gateway.extract(
        `Facts from a Monte Carlo probabilistic simulation of a ${scenarioType} scenario (use ONLY these numbers):\n${factsText}\n\n` +
          "Explain in 2-4 sentences the range of likely outcomes and the risk level, and what the person should take away " +
          "from the uncertainty range. Do not introduce any number not already given, and do not present any single outcome " +
          "as certain — this describes a probability distribution, not a guarantee.",
        explainSchema,
        {
          feature: "scenario_studio.explain_probabilistic",
          promptName: "scenario_studio.explain_probabilistic",
          userId,
          cacheable: false,
          complexityHint: "high",
        },
      );

      const verification = this.verifier.verify(gatewayResult.data.explanation, factsText);
      if (verification.passed) {
        return { text: gatewayResult.data.explanation, confidence: gatewayResult.confidence, verificationPassed: true };
      }

      this.logger.warn(
        `Probabilistic explanation failed numeric verification (unmatched: ${verification.unmatchedNumbers.join(", ")}) — falling back to facts summary.`,
      );
      return { text: factsText, confidence: 0.5, verificationPassed: false };
    } catch (err) {
      if (err instanceof AiUnavailableException) {
        this.logger.warn(`Probabilistic explanation unavailable: ${err.message}`);
        return { text: factsText, confidence: 0.5, verificationPassed: false };
      }
      throw err;
    }
  }

  /**
   * Explains an optimization/constraint-solver recommendation — why this parameter
   * value won the search, the tradeoff between median outcome and downside risk, and
   * any constraints that limited the search. Same verification/fallback pattern as
   * explain() and explainProbabilistic() above.
   */
  async explainOptimization(userId: string, optimized: OptimizedScenarioDTO): Promise<ExplanationResult> {
    const factsText = this.buildOptimizationFactsText(optimized);

    try {
      const gatewayResult = await this.gateway.extract(
        `Facts about an optimized ${optimized.scenarioType} recommendation (use ONLY these numbers):\n${factsText}\n\n` +
          "Explain in 2-4 sentences why this recommended parameter value was chosen over the rest of the searched range, " +
          "referencing the tradeoff between the median outcome and downside risk, and note any constraints that limited the search. " +
          "Do not introduce any number not already given.",
        explainSchema,
        {
          feature: "scenario_studio.explain_optimization",
          promptName: "scenario_studio.explain_optimization",
          userId,
          cacheable: false,
          complexityHint: "high",
        },
      );

      const verification = this.verifier.verify(gatewayResult.data.explanation, factsText);
      if (verification.passed) {
        return { text: gatewayResult.data.explanation, confidence: gatewayResult.confidence, verificationPassed: true };
      }

      this.logger.warn(
        `Optimization explanation failed numeric verification (unmatched: ${verification.unmatchedNumbers.join(", ")}) — falling back to facts summary.`,
      );
      return { text: factsText, confidence: 0.5, verificationPassed: false };
    } catch (err) {
      if (err instanceof AiUnavailableException) {
        this.logger.warn(`Optimization explanation unavailable: ${err.message}`);
        return { text: factsText, confidence: 0.5, verificationPassed: false };
      }
      throw err;
    }
  }

  private buildProbabilisticFactsText(scenarioType: ScenarioType, result: MonteCarloResultDTO): string {
    const p = result.terminalPercentiles;
    return (
      `${scenarioType} — Monte Carlo simulation over ${result.iterations} iterations, ${result.horizonYears.toFixed(1)}-year horizon.\n` +
      `10th percentile net worth: ₹${p.p10.toFixed(0)}\n` +
      `25th percentile net worth: ₹${p.p25.toFixed(0)}\n` +
      `Median (50th percentile) net worth: ₹${p.p50.toFixed(0)}\n` +
      `75th percentile net worth: ₹${p.p75.toFixed(0)}\n` +
      `90th percentile net worth: ₹${p.p90.toFixed(0)}\n` +
      `Probability of a net worth decline from today: ${(result.probabilityOfNetWorthDecline * 100).toFixed(0)}%\n` +
      `Risk level: ${result.riskLevel} (coefficient of variation ${(result.coefficientOfVariation * 100).toFixed(0)}%)`
    );
  }

  private buildOptimizationFactsText(optimized: OptimizedScenarioDTO): string {
    const p = optimized.monteCarlo.terminalPercentiles;
    const paramSummary = Object.entries(optimized.recommendedParams)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(", ");
    const violations = optimized.violatedConstraints.length > 0 ? optimized.violatedConstraints.join("; ") : "none";
    return (
      `Recommended ${optimized.scenarioType} parameters: ${paramSummary}\n` +
      `Searched range: ${optimized.searchRange.min.toFixed(0)} to ${optimized.searchRange.max.toFixed(0)} across ${optimized.candidatesEvaluated} candidates.\n` +
      `Resulting median (50th percentile) net worth: ₹${p.p50.toFixed(0)}, 10th percentile: ₹${p.p10.toFixed(0)}, 90th percentile: ₹${p.p90.toFixed(0)}.\n` +
      `Feasible under stated constraints: ${optimized.feasible ? "yes" : "no"}. Violated constraints: ${violations}.\n` +
      `Risk-adjusted score: ₹${optimized.riskAdjustedScore.toFixed(0)}.`
    );
  }
}
