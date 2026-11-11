
import { Injectable } from "@nestjs/common";
import { matchIntent, CoachIntent } from "../../../coach/coach.intents";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import {
  ADVANCED_INTENT_DESCRIPTIONS,
  ADVANCED_INTENT_LABELS,
  AdvancedCoachIntent,
} from "../coach2.constants";

export type ClassificationResult =
  | { path: "deterministic"; intent: CoachIntent }
  | { path: "advanced"; intent: AdvancedCoachIntent; confidence: number }
  | { path: "advanced"; intent: "general_search"; confidence: number };

const PRIORITIZATION_PATTERN =
  /\bprioriti[sz](?:e|ed|ing|ation)\b/i;

const PRIORITIZATION_CONTEXT_PATTERN =
  /\b(financial|finance|money|improvement|action|actions|recommendation|recommendations|goal|goals|task|tasks|expense|expenses|debt|debts|investment|investments|plan|plans)\b/i;

const PRIORITIZED_PLAN_PATTERN =
  /\b(?:create|make|build|prepare|generate|develop|give me)\b.{0,100}\b(?:prioritized|prioritised|priority-based)\b.{0,100}\b(?:financial|finance|money|improvement|action|recommendation|plan)\b/i;

const GENERAL_FINANCIAL_PLAN_PATTERN =
  /\b(?:financial|finance|money)\s+(?:health\s+)?improvement\s+plan\b/i;

const ADVANCED_ONLY_PATTERNS: RegExp[] = [
  /\bafford\b/i,
  /overcommitted/i,
  /\bconflict/i,
  /trade-?off/i,
  PRIORITIZATION_PATTERN,
  /\bcompare.*(?:month|year|period|quarter)/i,

  /\b(set up|create|start|build|make)\b.*\bplan\b/i,
  /\bplan\b.*\b(to|for)\b.*(pay off|save|retire|invest|buy)/i,
  /(pay off|payoff).{0,40}\bin\b\s*\d+\s*(month|year)/i,
  /\bsave\b.{0,40}\b(in|by|within)\b\s*\d+\s*(month|year)/i,
  /help me (pay off|save (up|for)|reach|hit)\b/i,

  /\bon track\b/i,
  /progress.*(plan|goal)/i,
  /how.?s my (plan|goal)/i,
  /(check|update).*(plan|goal).*(status|progress)/i,

  /what (would|will) my emi/i,
  /what if i (pay|prepay|invest|save|borrow)/i,
  /how much (do i need|should i|would i) (save|invest|pay)/i,
  /\bcalculate\b/i,
];

@Injectable()
export class IntentClassifierService {
  constructor(private gateway: AiGatewayService) {}

  async classify(
    userId: string,
    question: string,
  ): Promise<ClassificationResult> {
    const text = (question ?? "").trim();

    if (!text) {
      return {
        path: "advanced",
        intent: "general_search",
        confidence: 0,
      };
    }

    const isPrioritizationRequest =
      (PRIORITIZATION_PATTERN.test(text) &&
        PRIORITIZATION_CONTEXT_PATTERN.test(text)) ||
      PRIORITIZED_PLAN_PATTERN.test(text) ||
      GENERAL_FINANCIAL_PLAN_PATTERN.test(text);

    if (isPrioritizationRequest) {
      return {
        path: "advanced",
        intent: "prioritize_actions",
        confidence: 1,
      };
    }

    const needsAdvancedReasoning = ADVANCED_ONLY_PATTERNS.some((pattern) =>
      pattern.test(text),
    );

    const deterministic = needsAdvancedReasoning
      ? null
      : matchIntent(text);

    if (deterministic) {
      return {
        path: "deterministic",
        intent: deterministic,
      };
    }

    try {
      const descriptions = ADVANCED_INTENT_LABELS.map(
        (label) =>
          `- ${label}: ${ADVANCED_INTENT_DESCRIPTIONS[label]}`,
      ).join("\n");

      const result = await this.gateway.classify(
        `${text}\n\nCategories:\n${descriptions}`,
        ADVANCED_INTENT_LABELS,
        {
          feature: "coach2.classify_advanced",
          promptName: "coach2.classify_advanced",
          userId,
          cacheable: false,
        },
      );

      return {
        path: "advanced",
        intent: result.data.label,
        confidence: result.confidence,
      };
    } catch (err) {
      if (
        err instanceof AiUnavailableException ||
        err instanceof Error
      ) {
        return {
          path: "advanced",
          intent: "general_search",
          confidence: 0,
        };
      }

      throw err;
    }
  }
}
