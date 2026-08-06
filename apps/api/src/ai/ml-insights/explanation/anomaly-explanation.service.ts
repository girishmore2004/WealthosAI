import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { NumericConsistencyVerifier } from "../../coach/verification/numeric-consistency.verifier";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { ExpenseAnomaly } from "../models/anomaly-detection.model";

const explainSchema = z.object({ explanation: z.string() });

export interface AnomalyExplanationResult {
  narrative: string;
  confidence: number;
  verificationPassed: boolean;
  /** True whenever the narrative is the deterministic rule-based fallback rather than
   * an LLM-composed one — surfaced to the UI/API consumer explicitly rather than left
   * to infer from confidence alone, per the audit's "clear fallback when models are
   * unavailable" requirement. */
  usedFallback: boolean;
}

// Same pattern as ScenarioExplainerService (scenario-studio/explanation): all LLM
// involvement in ML Insights goes through AiGatewayService.extract() — never a direct
// model call — and every composed sentence is checked against
// NumericConsistencyVerifier before being trusted, because AnomalyDetectionModel's
// deterministic `likelyCauses` (see ../models/anomaly-detection.model.ts) are the only
// facts this is allowed to draw on. If the model is unavailable OR it introduces a
// number/cause not present in those facts, this falls back to a narrative built
// directly from likelyCauses — never a hallucinated prediction, satisfying the
// "clear fallback when models are unavailable" requirement precisely the same way
// Scenario Studio's explainer already does for its own domain.
@Injectable()
export class AnomalyExplanationService {
  private readonly logger = new Logger(AnomalyExplanationService.name);

  constructor(
    private gateway: AiGatewayService,
    private verifier: NumericConsistencyVerifier,
  ) {}

  async explain(userId: string, anomalies: ExpenseAnomaly[]): Promise<AnomalyExplanationResult> {
    if (anomalies.length === 0) {
      return { narrative: "No anomalies detected this period.", confidence: 1, verificationPassed: true, usedFallback: false };
    }

    const factsText = this.buildFactsText(anomalies);

    try {
      const result = await this.gateway.extract(
        `Facts about flagged unusual expense transactions, including their deterministic likely cause(s) (use ONLY these numbers and causes):\n${factsText}\n\n` +
          "In 2-4 sentences, explain the most likely reasons these transactions were flagged as unusual, grounded only in " +
          "the listed causes and figures. Do not invent a cause, merchant, or number not given above.",
        explainSchema,
        {
          feature: "ml_insights.explain_anomaly",
          promptName: "ml_insights.explain_anomaly",
          userId,
          // Cacheable: the same set of flagged anomalies (same facts text) should
          // reliably produce the same explanation, and this method may be called on
          // every dashboard load — caching avoids burning Groq quota re-explaining
          // the identical set of anomalies each time nothing new has been flagged.
          cacheable: true,
          groundingContext: factsText,
          rejectOnLowGrounding: false,
        },
      );

      const verification = this.verifier.verify(result.data.explanation, factsText);
      if (verification.passed) {
        return { narrative: result.data.explanation, confidence: result.confidence, verificationPassed: true, usedFallback: false };
      }

      this.logger.warn(
        `Anomaly explanation failed numeric verification (unmatched: ${verification.unmatchedNumbers.join(", ")}) — falling back to deterministic causes.`,
      );
      return { narrative: this.fallbackNarrative(anomalies), confidence: 0.5, verificationPassed: false, usedFallback: true };
    } catch (err) {
      if (err instanceof AiUnavailableException) {
        this.logger.warn(`Anomaly explanation unavailable: ${err.message}`);
        return { narrative: this.fallbackNarrative(anomalies), confidence: 0.5, verificationPassed: false, usedFallback: true };
      }
      throw err;
    }
  }

  private buildFactsText(anomalies: ExpenseAnomaly[]): string {
    return anomalies
      .slice(0, 5)
      .map(
        (a) =>
          `"${a.categoryName}" transaction of ₹${a.amount.toFixed(0)} (category median ₹${a.categoryMedian.toFixed(0)}, modified z-score ${a.zScore}) — likely cause(s): ${a.likelyCauses.join("; ")}`,
      )
      .join("\n");
  }

  /** Deterministic fallback narrative — built directly from AnomalyDetectionModel's
   * own rule-based `likelyCauses`, never from anything the LLM produced. This is what
   * the UI shows whenever the gateway call fails or its output doesn't pass
   * verification, so a person always gets a real, traceable answer instead of
   * silence or a hallucinated one. */
  private fallbackNarrative(anomalies: ExpenseAnomaly[]): string {
    const top = anomalies[0];
    return `Rule-based fallback (AI explanation unavailable): the most notable flagged transaction is in "${top.categoryName}" at ₹${top.amount.toFixed(0)} — ${top.likelyCauses[0]?.toLowerCase() ?? "it sits far outside this category's typical range"}.${
      anomalies.length > 1 ? ` ${anomalies.length - 1} additional transaction(s) were also flagged.` : ""
    }`;
  }
}
