import { NumericConsistencyVerifier } from "../../coach/verification/numeric-consistency.verifier";
import { ToolOutcome } from "../agent.types";
import { renderRawFacts } from "../../financial-engine/answer-composer";

export interface AgentVerification {
  passed: boolean;
  issues: string[];
}

// Last line of defence on the text the agent itself assembled or a model worded. Every number in `text` must appear in the
// material the agent actually had: tool outputs (verified facts and their rendered text), the user's own message and the
// recalled memories. A number that exists nowhere in that material was invented, and the answer is rejected.
export function verifyAgentText(verifier: NumericConsistencyVerifier, text: string, outcomes: ToolOutcome[], extraSources: string[] = []): AgentVerification {
  const factsText = [
    ...outcomes.flatMap((o) => [o.text, o.facts ? renderRawFacts(o.facts) : "", ...o.calculations.map((c) => `${c.label} ${c.value} ${c.basis ?? ""}`), ...o.evidence.map((e) => `${e.label} ${e.detail ?? ""} ${e.asOf ?? ""}`), ...o.assumptions, ...o.recommendations]),
    ...extraSources,
  ].join("\n");
  const result = verifier.verify(text, factsText);
  return { passed: result.passed, issues: result.passed ? [] : result.unmatchedNumbers.map((n) => `Number not found in the verified sources: ${n}`) };
}

/** True when a tool's own output is already verified upstream (finance engine / coach pipelines verify before returning). */
export function isUpstreamVerified(o: ToolOutcome): boolean {
  const v = (o.data as { verification?: { passed?: boolean } } | undefined)?.verification;
  return v?.passed === true;
}
