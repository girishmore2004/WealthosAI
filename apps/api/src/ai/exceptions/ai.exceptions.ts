import { HttpException, HttpStatus } from "@nestjs/common";

// Thrown when the underlying model call fails outright — no API key configured,
// network error, timeout, or a non-2xx response from Groq after exhausting retries.
// Callers (e.g. a future Coach service) are expected to catch this and fall back to
// the deterministic path rather than let it surface as a raw 503 to the end user —
// this class exists so that catch can be `catch (e) { if (e instanceof
// AiUnavailableException) { ...fallback... } }` instead of string-matching an error.
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
