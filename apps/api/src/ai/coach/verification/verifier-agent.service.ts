import { Injectable } from "@nestjs/common";
import { NumericConsistencyVerifier, VerificationResult } from "./numeric-consistency.verifier";

export interface PlanConsistencyContext {
  targetValue: number;
  targetDateIso: string; // YYYY-MM-DD
}

// --- THE VERIFIER AGENT ----------------------------------------------------------------
//
// A thin orchestration layer over NumericConsistencyVerifier (unchanged, still the
// hard numeric-hallucination gate every composed answer must pass) that adds one
// additional, plan-specific check: when the composed answer is reporting on a
// CoachPlan, the plan's OWN targetValue/targetDate — the numbers the Planner Agent
// actually wrote to the database — must themselves appear in the factsText the
// composer was given. This catches a narrower but real failure mode the base verifier
// alone wouldn't: the composer correctly avoiding invented numbers, but the gatherer
// or orchestrator accidentally handing it a stale or wrong plan's facts. If the plan's
// own target isn't present in what was fed to the model, that's an orchestration bug,
// not a model hallucination — surfaced here rather than silently returned to the user
// as if it were correct.
@Injectable()
export class VerifierAgentService {
  constructor(private numericVerifier: NumericConsistencyVerifier) {}

  verify(composedText: string, factsText: string, planContext?: PlanConsistencyContext): VerificationResult {
    const baseResult = this.numericVerifier.verify(composedText, factsText);
    if (!planContext) return baseResult;

    const planNumbersInFacts = this.numericVerifier.extractNumbers(factsText);
    const targetPresent = planNumbersInFacts.some((n) => Math.abs(n.value - planContext.targetValue) <= Math.max(1, planContext.targetValue * 0.01));
    const datePresent = factsText.includes(planContext.targetDateIso) || factsText.includes(planContext.targetDateIso.slice(0, 7));

    if (targetPresent && datePresent) return baseResult;

    return {
      passed: false,
      unmatchedNumbers: [
        ...baseResult.unmatchedNumbers,
        ...(targetPresent ? [] : [`plan target ${planContext.targetValue}`]),
        ...(datePresent ? [] : [`plan target date ${planContext.targetDateIso}`]),
      ],
    };
  }
}
