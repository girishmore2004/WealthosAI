import { Injectable, Logger } from "@nestjs/common";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { IntentResult, LLM_CLASSIFIABLE_INTENTS } from "../agent.types";
import { INTENT_RULES_MIN_CONFIDENCE, classifyIntentRules } from "./intent-rules";

export interface HistoryTurn {
  role: "USER" | "ASSISTANT";
  content: string;
}

// A message that names its own financial topic is a new question, not a follow-up, even when it is short ("Check my insurance premiums").
const OWN_TOPIC = /\b(insurance|premiums?|polic(?:y|ies)|loans?|emis?|spending|expenses?|income|salary|savings?|invest\w*|sips?|goals?|net worth|audit|budget|tax\w*)\b/i;
const FOLLOW_UP = /^\s*(and|what about|how about|also|then|same (?:for|with)|but|ok(?:ay)?,? (?:and|what about)|why|how come|compare (?:it|that|this))\b/i;

/** Rewrites a short follow-up ("what about last month?") into a self-contained question using the previous user turn, so tools that
 * need a standalone question (finance engine, RAG) can answer it. Pure and deterministic; returns the message unchanged when it
 * is not a follow-up. */
export function resolveFollowUp(message: string, history: HistoryTurn[]): string {
  const text = message.trim();
  const words = text.split(/\s+/).length;
  if (words > 8 && !FOLLOW_UP.test(text)) return text;
  if (!FOLLOW_UP.test(text) && OWN_TOPIC.test(text)) return text;
  if (!FOLLOW_UP.test(text) && words > 4) return text;
  const prev = [...history].reverse().find((h) => h.role === "USER");
  if (!prev) return text;
  return `${prev.content.trim().slice(0, 300)} (follow-up: ${text})`.slice(0, 500);
}

@Injectable()
export class AgentIntentService {
  private readonly logger = new Logger(AgentIntentService.name);

  constructor(private gateway: AiGatewayService) {}

  /** Rules first; the model is consulted only for genuinely unclear messages, and can only choose among the benign intents. */
  async understand(userId: string, message: string, ctx: { hasAttachments: boolean; history: HistoryTurn[] }): Promise<IntentResult> {
    const ruled = classifyIntentRules(message, { hasAttachments: ctx.hasAttachments });
    if (ruled.confidence >= INTENT_RULES_MIN_CONFIDENCE || ruled.intent === "unsupported_action" || ruled.intent === "clarification") return ruled;
    try {
      const prev = [...ctx.history].reverse().find((h) => h.role === "USER");
      const input = `${prev ? `Previous user message: ${prev.content.slice(0, 200)}\n` : ""}Message to classify: ${message.slice(0, 500)}`;
      const res = await this.gateway.classify(input, [...LLM_CLASSIFIABLE_INTENTS] as [string, ...string[]], {
        feature: "agent.classify_intent",
        promptName: "agent.classify_intent",
        userId,
        cacheable: false,
      });
      // A model may not turn an unclear message into a write: without a rule-matched action tool it is treated as a read-only question.
      if (res.data.label === "action_request" && !ruled.actionTool) return { ...ruled, intent: "financial_analysis", source: "model", reasons: [...ruled.reasons, "model suggested an action but no action wording matched; treated as a question"] };
      return { intent: res.data.label as IntentResult["intent"], confidence: Math.min(0.8, res.confidence), reasons: ["model classification after unclear rules"], source: "model", ...(res.data.label === "action_request" ? { actionTool: ruled.actionTool } : {}) };
    } catch (err) {
      this.logger.warn(`intent model unavailable: ${(err as Error).name}`);
      return { ...ruled, source: "default", reasons: [...ruled.reasons, "model unavailable"] };
    }
  }
}
