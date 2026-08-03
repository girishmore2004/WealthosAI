import { HttpException, HttpStatus } from "@nestjs/common";

// Thrown when the underlying model call fails outright — no API key configured,
// network error, timeout, or a non-2xx response from Groq after exhausting retries.
// Callers (e.g. a future Coach service) are expected to catch this and fall back to
// the deterministic path rather than let it surface as a raw 503 to the end user —
// this class exists so that catch can be `catch (e) { if (e instanceof
// AiUnavailableException) { ...fallback... } }` instead of string-matching an error.
//
// NOTE: AiGatewayService now walks a multi-model fallback chain (see
// model-router.service.ts's RoutingDecision.chain) before this is ever thrown — this
// exception means every candidate model in the chain failed, not just the first one.
export class AiUnavailableException extends HttpException {
  constructor(reason: string) {
    super(`AI service unavailable: ${reason}`, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

// Thrown when the model responded, but its output never became schema-valid JSON even
// after AiGatewayService's retry-with-correction attempts, and the caller did not
// supply a `fallback` value to runStructured(). Distinct from AiUnavailableException
// because this is a "the model answered badly" failure, not a "the model didn't
// answer" failure — useful to distinguish in logs/alerting.
export class AiValidationException extends HttpException {
  constructor(promptName: string, retries: number) {
    super(
      `AI response for "${promptName}" failed schema validation after ${retries} ${retries === 1 ? "retry" : "retries"}`,
      HttpStatus.BAD_GATEWAY,
    );
  }
}

// Thrown when the model's response was well-formed and schema-valid, but introduced
// figures (or, secondarily, substantial unrelated wording) not present in the
// caller-supplied `groundingContext` (see AiCallOptions.groundingContext) — and stayed
// that way even after one corrective retry that fed the mismatched figures back to the
// model. Only ever thrown when the caller opted into `rejectOnLowGrounding: true`;
// otherwise a low groundingScore is still computed and returned/logged (see
// AiResult.hallucinationRisk) but never blocks the response. Distinct from
// AiValidationException (shape was fine, content wasn't) and from
// AiUnavailableException (the model did answer) — callers that pass groundingContext
// and reject on it are expected to catch this the same way they already catch
// AiUnavailableException, and fall back to an ungrounded-but-safe response (e.g. the
// raw facts text, as Scenario Studio's explainer already does with its own bespoke
// verifier).
export class AiGroundingException extends HttpException {
  constructor(promptName: string, unmatchedNumbers: string[]) {
    super(
      `AI response for "${promptName}" failed grounding verification after a corrective retry` +
        (unmatchedNumbers.length > 0
          ? ` — introduced figures not present in the supplied context: ${unmatchedNumbers.join(", ")}`
          : " — introduced content not supported by the supplied context"),
      HttpStatus.BAD_GATEWAY,
    );
  }
}
