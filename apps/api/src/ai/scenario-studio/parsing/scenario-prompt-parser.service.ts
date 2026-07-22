import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { ScenarioType } from "@wealthos/types";

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
];

// Shown to the model so it knows which fields to populate for whichever scenarioType
// it picks — kept next to SimulatorService's own REQUIRED_FIELDS in spirit (same
// field names), duplicated rather than imported because SimulatorService lives outside
// this module's dependency graph and this is presentation text, not validation logic
// — SimulatorService.run() (via ScenarioExpanderService) is what actually enforces
// these fields are present and numeric; if the model gets a field wrong, that call
// throws a clear error rather than silently proceeding with bad data.
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
};

const parseSchema = z.object({
  scenarioType: z.enum(SCENARIO_TYPES),
  params: z.record(z.union([z.number(), z.string()])).describe("Only the numeric fields relevant to the chosen scenarioType"),
  understood: z.boolean().describe("False if the prompt doesn't clearly describe one of the supported scenario types"),
});

export interface ParsedScenarioPrompt {
  understood: boolean;
  scenarioType: ScenarioType | null;
  params: Record<string, unknown>;
}

@Injectable()
export class ScenarioPromptParserService {
  constructor(private gateway: AiGatewayService) {}

  async parse(userId: string, prompt: string): Promise<ParsedScenarioPrompt> {
    const hints = SCENARIO_TYPES.map((t) => `- ${t}: ${SCENARIO_FIELD_HINTS[t]}`).join("\n");
    const input =
      `User's scenario prompt: "${prompt}"\n\n` +
      `Supported scenario types and their fields:\n${hints}\n\n` +
      "Pick the single best-fitting scenarioType and extract only its relevant numeric params from the prompt. " +
      "If a required field isn't mentioned, make a reasonable estimate ONLY for percentIncrease/percentDecrease/" +
      "delayMonths-style small inputs; for large ambiguous amounts (propertyValue, lumpSum, amount), leave params " +
      "incomplete rather than guessing a large number — downstream validation will report exactly what's missing. " +
      "If nothing in the prompt matches a supported scenario type, set understood to false.";

    const result = await this.gateway.extract(input, parseSchema, {
      feature: "scenario_studio.parse_prompt",
      promptName: "scenario_studio.parse_prompt",
      userId,
      cacheable: false,
    });

    if (!result.data.understood) {
      return { understood: false, scenarioType: null, params: {} };
    }

    return { understood: true, scenarioType: result.data.scenarioType, params: result.data.params };
  }
}
