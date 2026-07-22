import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { NumericConsistencyVerifier } from "../../coach/verification/numeric-consistency.verifier";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { ScenarioVariant } from "../expansion/scenario-expander.service";
import { RankedVariant } from "../ranking/scenario-ranking.service";

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
}
