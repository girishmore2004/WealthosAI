import { Injectable, Logger } from "@nestjs/common";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException, AiValidationException } from "../../exceptions/ai.exceptions";

export type CriticFlag = "OVERPROMISING" | "UNSAFE_ADVICE" | "NEEDS_DISCLAIMER";
export type CriticSeverity = "none" | "medium" | "high";

export interface CriticResult {
  flags: CriticFlag[];
  severity: CriticSeverity;
  /** Plain-language note appended to a refine-retry prompt, explaining exactly what
   * to fix — empty when severity is "none". */
  guidance: string;
}

// Absolute-certainty / guarantee language a personal-finance coach should never use —
// markets and life circumstances aren't certain, and implying otherwise is the kind of
// over-promise this agent exists to catch even when every number in the sentence is
// individually correct.
const OVERPROMISE_PATTERNS: RegExp[] = [
  /\bguarantee[sd]?\b/i,
  /\brisk-?free\b/i,
  /\bcan'?t lose\b/i,
  /\bnever lose\b/i,
  /\b100%\s*(safe|certain|sure|guaranteed)\b/i,
  /\balways (grows|goes up|increases)\b/i,
  /\byou will definitely\b/i,
  /\bno risk\b/i,
];

// Patterns that suggest a genuinely unsafe course of action rather than just
// overconfident wording — these should block the answer outright (severity "high"),
// not just prompt a softer rewrite.
const UNSAFE_ADVICE_PATTERNS: RegExp[] = [
  /\bborrow(ing)? against (your |my )?(retirement|pf|epf|ppf|pension)\b/i,
  /\bwithdraw (your |my )?(entire|whole|all of your) (retirement|pf|epf|ppf|pension)\b/i,
  /\bstop (paying for|your) insurance\b/i,
  /\bput (all|everything) (of )?(your |my )?(savings|money) into\b/i,
  /\btake (a |out a )?loan to invest\b/i,
  /\bskip (your |the )?emi\b/i,
];

// Patterns that are legitimate but incomplete advice — not wrong, just needs a
// standard caveat rather than a full block or rewrite.
const NEEDS_DISCLAIMER_PATTERNS: RegExp[] = [/\byou should invest in\b/i, /\byou should buy\b/i, /\bswitch to\b.{0,20}\bfund\b/i];

@Injectable()
export class CriticAgentService {
  private readonly logger = new Logger(CriticAgentService.name);

  constructor(private gateway: AiGatewayService) {}

  async critique(userId: string, composedAnswer: string): Promise<CriticResult> {
    const flags = new Set<CriticFlag>();

    if (OVERPROMISE_PATTERNS.some((p) => p.test(composedAnswer))) flags.add("OVERPROMISING");
    if (UNSAFE_ADVICE_PATTERNS.some((p) => p.test(composedAnswer))) flags.add("UNSAFE_ADVICE");
    if (NEEDS_DISCLAIMER_PATTERNS.some((p) => p.test(composedAnswer))) flags.add("NEEDS_DISCLAIMER");

    // The heuristics above are deliberately high-precision, low-recall (exact
    // phrases) — they catch the obvious cases cheaply and for free (no AI call) even
    // when the gateway is unavailable. The LLM classification call below is a
    // second, lower-precision-but-higher-recall pass that can catch phrasing the
    // fixed regex list doesn't anticipate. Its failure must never block a response
    // that already passed the heuristic pass — this is a best-effort enhancement,
    // not a hard gate on its own.
    try {
      const result = await this.gateway.classify(
        composedAnswer,
        ["safe", "overpromising", "unsafe_advice", "needs_disclaimer"],
        {
          feature: "coach2.critic",
          promptName: "coach2.critic_check",
          userId,
          cacheable: false,
          complexityHint: "low",
        },
      );

      if (result.data.label === "overpromising") flags.add("OVERPROMISING");
      if (result.data.label === "unsafe_advice") flags.add("UNSAFE_ADVICE");
      if (result.data.label === "needs_disclaimer") flags.add("NEEDS_DISCLAIMER");
    } catch (err) {
      if (err instanceof AiUnavailableException || err instanceof AiValidationException) {
        this.logger.warn(`Critic Agent's LLM check unavailable, using heuristic-only result: ${(err as Error).message}`);
      } else {
        throw err;
      }
    }

    return this.buildResult(Array.from(flags));
  }

  private buildResult(flags: CriticFlag[]): CriticResult {
    if (flags.includes("UNSAFE_ADVICE")) {
      return {
        flags,
        severity: "high",
        guidance:
          "Your previous answer suggested something potentially unsafe (e.g. borrowing against retirement savings, " +
          "stopping insurance, or concentrating all savings in one place). Rewrite using ONLY the given facts, " +
          "remove any such suggestion, and stick to describing the numbers and their implications rather than " +
          "directive action.",
      };
    }
    if (flags.includes("OVERPROMISING")) {
      return {
        flags,
        severity: "medium",
        guidance:
          "Your previous answer used absolute/guarantee language (e.g. 'guaranteed', 'risk-free', 'can't lose'). " +
          "Rewrite it without any certainty claims — describe the numbers plainly instead.",
      };
    }
    if (flags.includes("NEEDS_DISCLAIMER")) {
      return {
        flags,
        severity: "medium",
        guidance:
          "Your previous answer directed the user toward a specific action (e.g. 'you should invest in...'). " +
          "Rewrite it as informational framing rather than a directive recommendation, and note this is " +
          "general information, not personalized financial advice.",
      };
    }
    return { flags: [], severity: "none", guidance: "" };
  }
}
