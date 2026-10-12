import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiResult } from "../../gateway/ai-gateway.types";
import { AiUnavailableException, AiValidationException } from "../../exceptions/ai.exceptions";
import { ScenarioType } from "@wealthos/types";
import { classifyScenarioIntent } from "./scenario-intent-classifier";
import {
  ALLOWED_SCENARIO_FIELDS,
  PRIMARY_SCENARIO_FIELD,
  extractPrimaryParams,
  sanitizeScenarioParams,
} from "./scenario-param-utils";

const SCENARIO_TYPES: [ScenarioType, ...ScenarioType[]] = [
  "SALARY_HIKE",
  "SALARY_DROP",
  "SIP_INCREASE",
  "SIP_DECREASE",
  "HOUSE_PURCHASE",
  "LOAN_PREPAYMENT",
  "RETIREMENT_AGE_SHIFT",
  "EMERGENCY_EXPENSE",
  "GOAL_DELAY",
  "NEW_LOAN",
];

// Below this self-reported confidence, an AI-only classification (the deterministic
// classifier found nothing) is treated as unresolved rather than acted on.
const MIN_AI_CLASSIFICATION_CONFIDENCE = 0.5;

// Shown to the model so it knows which fields to populate for whichever scenarioType
// it picks — kept next to SimulatorService's own REQUIRED_FIELDS in spirit (same
// field names), duplicated rather than imported because SimulatorService lives outside
// this module's dependency graph and this is presentation text, not validation logic
// — SimulatorService.run() (via ScenarioExpanderService) is what actually enforces
// these fields are present and numeric; if a field is missing, that call throws a clear
// error rather than silently proceeding with bad data.
const SCENARIO_FIELD_HINTS: Record<ScenarioType, string> = {
  SALARY_HIKE: "percentIncrease (number)",
  SALARY_DROP: "percentDecrease (number)",
  SIP_INCREASE: "additionalMonthlyAmount (number, ₹/month)",
  SIP_DECREASE: "reducedMonthlyAmount (number, ₹/month)",
  HOUSE_PURCHASE: "propertyValue (number, ₹), downPaymentPercent (number), loanInterestRateAnnual (number), loanTenureMonths (number)",
  LOAN_PREPAYMENT: "lumpSum (number, ₹) — loanId cannot be guessed from text, leave it out",
  RETIREMENT_AGE_SHIFT: "newRetirementAge (number, years)",
  EMERGENCY_EXPENSE: "amount (number, ₹)",
  GOAL_DELAY: "delayMonths (number) — goalId cannot be guessed from text, leave it out",
  NEW_LOAN:
    "loanAmount (number, ₹), annualRatePercent (number), tenureMonths (number), purpose (string, optional) — use this for a NEW loan not tied to buying a house (business expansion, equipment, a personal loan, etc.); do not use LOAN_PREPAYMENT (that's for paying down an EXISTING loan) or HOUSE_PURCHASE (that's specifically for buying property) for these",
};

// `scenarioType` is nullable ON PURPOSE. The model is told to answer null when the prompt
// is unrelated, unsupported, ambiguous or mixes scenarios; a non-nullable enum made that
// honest answer fail schema validation on every retry ("Expected 'SALARY_HIKE' | ... ,
// received null") and surfaced as a 502 instead of a clarification. `params` tolerates
// null/missing for the same reason.
const parseSchema = z.object({
  scenarioType: z.enum(SCENARIO_TYPES).nullable(),
  params: z
    .record(z.union([z.number(), z.string()]))
    .nullable()
    .optional()
    .describe("Only numeric fields literally written in the prompt, relevant to the chosen scenarioType; empty when scenarioType is null"),
  understood: z.boolean().describe("False if the prompt doesn't clearly describe exactly one supported scenario type"),
});

/** Why a prompt did not resolve to a runnable scenario:
 * - "ambiguous": it matches more than one supported scenario (or is negated) — ask which one;
 * - "unsupported": nothing supported matched, or the AI answered null / low confidence;
 * - "unavailable": nothing deterministic matched and the AI parser could not be used
 *   (provider failure, timeout, or malformed output) — safe to retry later. */
export type ScenarioUnresolvedReason = "ambiguous" | "unsupported" | "unavailable";

export interface ParsedScenarioPrompt {
  understood: boolean;
  scenarioType: ScenarioType | null;
  params: Record<string, unknown>;
  /** Present only when `understood` is false. Optional for backward compatibility. */
  reason?: ScenarioUnresolvedReason;
  /** For reason "ambiguous": the supported types the prompt matched. */
  candidates?: ScenarioType[];
}

function unresolved(reason: ScenarioUnresolvedReason, candidates?: ScenarioType[]): ParsedScenarioPrompt {
  return { understood: false, scenarioType: null, params: {}, reason, ...(candidates ? { candidates } : {}) };
}

@Injectable()
export class ScenarioPromptParserService {
  private readonly logger = new Logger(ScenarioPromptParserService.name);

  constructor(private gateway: AiGatewayService) {}

  async parse(userId: string, prompt: string): Promise<ParsedScenarioPrompt> {
    const text = (prompt ?? "").trim();
    if (text.length === 0) return unresolved("unsupported");

    // 1) Conservative deterministic classification. A prompt that matches several supported
    //    scenarios (or is negated) is never silently resolved to one of them.
    const intent = classifyScenarioIntent(text);
    if (intent.status === "ambiguous") return unresolved("ambiguous", intent.candidates);

    const deterministicType = intent.status === "clear" ? intent.scenarioType : null;

    // 2) Single-field scenarios whose headline figure is stated exactly once need no model.
    if (deterministicType && ALLOWED_SCENARIO_FIELDS[deterministicType].length === 1) {
      const primary = extractPrimaryParams(deterministicType, text);
      if (Object.keys(primary).length > 0) {
        return { understood: true, scenarioType: deterministicType, params: primary };
      }
    }

    // 3) Ask the model — to classify (nothing deterministic matched) and/or to extract the
    //    remaining fields. Failures here are expected, recoverable conditions, not 502s.
    const hints = SCENARIO_TYPES.map((t) => `- ${t}: ${SCENARIO_FIELD_HINTS[t]}`).join("\n");
    const typeInstruction = deterministicType
      ? `The scenario type has already been identified as ${deterministicType}; set scenarioType to ${deterministicType} and extract only its fields.`
      : "Pick the single best-fitting scenarioType. If the prompt does not clearly describe exactly one supported type, set scenarioType to null and understood to false.";
    const input =
      `User's scenario prompt: "${text}"\n\n` +
      `Supported scenario types and their fields:\n${hints}\n\n` +
      `${typeInstruction} ` +
      "Extract only numeric params that are literally written in the prompt. Never estimate or assume an amount, " +
      "rate, return, age, percentage or date the prompt does not state — leave that field out; downstream " +
      "validation will report exactly what is missing.";

    let result: AiResult<z.infer<typeof parseSchema>>;
    try {
      result = await this.gateway.extract(input, parseSchema, {
        feature: "scenario_studio.parse_prompt",
        promptName: "scenario_studio.parse_prompt",
        userId,
        cacheable: false,
        complexityHint: "low",
        // A schema failure here is deterministic (the model keeps answering in the same shape), so
        // one corrective attempt is enough; the safe fallbacks below make further retries pure cost.
        maxCorrectiveRetries: 1,
      });
    } catch (err) {
      if (err instanceof AiUnavailableException || err instanceof AiValidationException) {
        this.logger.warn(
          `Scenario prompt parsing fell back without the AI parser (${err.constructor.name}); deterministic type: ${deterministicType ?? "none"}`,
        );
        if (deterministicType) {
          return { understood: true, scenarioType: deterministicType, params: extractPrimaryParams(deterministicType, text) };
        }
        return unresolved("unavailable");
      }
      throw err;
    }

    const data = result.data;

    // Deterministic classification wins: the model contributes parameters only, and only when it
    // agrees on the type (a different type means its params were extracted for the wrong scenario).
    if (deterministicType) {
      const params =
        data.scenarioType === deterministicType
          ? this.cleanParams(deterministicType, data.params, text)
          : extractPrimaryParams(deterministicType, text);
      return { understood: true, scenarioType: deterministicType, params };
    }

    // AI-only classification: require an explicit, confident, non-null answer.
    if (!data.understood || data.scenarioType === null || result.confidence < MIN_AI_CLASSIFICATION_CONFIDENCE) {
      return unresolved("unsupported");
    }
    return {
      understood: true,
      scenarioType: data.scenarioType,
      params: this.cleanParams(data.scenarioType, data.params, text),
    };
  }

  /** Allowed fields only, numeric values only when the prompt actually states them, plus the
   * deterministic headline value when the model missed or mis-stated it. */
  private cleanParams(
    type: ScenarioType,
    raw: Record<string, number | string> | null | undefined,
    prompt: string,
  ): Record<string, unknown> {
    const { params, dropped } = sanitizeScenarioParams(type, raw ?? {}, prompt);
    if (dropped.length > 0) {
      this.logger.debug(`Dropped unsupported scenario params [${dropped.join(", ")}] for ${type}`);
    }
    const primary = extractPrimaryParams(type, prompt);
    const field = PRIMARY_SCENARIO_FIELD[type];
    return field in primary ? { ...params, [field]: primary[field] } : params;
  }
}
