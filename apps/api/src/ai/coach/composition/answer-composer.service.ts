import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";

const composeSchema = z.object({
  answer: z.string(),
});

export interface ComposeResult {
  answer: string;
  confidence: number;
}

@Injectable()
export class AnswerComposerService {
  constructor(private gateway: AiGatewayService) {}

  /** `facts` must be the ONLY source of numbers the composed answer may use — this is
   * enforced downstream by NumericConsistencyVerifier, not by this method, but the
   * prompt itself is written to make that constraint explicit to the model too
   * (defense in depth: prompt instruction + code-level verification, not either
   * alone). */
  async compose(userId: string, question: string, facts: string, promptName: string): Promise<ComposeResult> {
    const input = `Question: ${question}\n\nFacts (use ONLY these numbers — do not calculate, estimate, or introduce any figure not already here):\n${facts}`;

    const result = await this.gateway.extract(input, composeSchema, {
      feature: "coach2.compose",
      promptName,
      userId,
      cacheable: false,
    });

    return { answer: result.data.answer, confidence: result.confidence };
  }
}
