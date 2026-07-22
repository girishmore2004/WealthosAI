import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiUnavailableException } from "../exceptions/ai.exceptions";

export interface GroqChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GroqChatParams {
  model: string;
  messages: GroqChatMessage[];
  temperature: number;
  maxTokens: number;
  /** Groq's JSON mode — the model is constrained to emit a single JSON object. Still
   * needs schema validation on our side; JSON mode guarantees parseable JSON, not that
   * the JSON matches our shape. */
  jsonMode: boolean;
}

export interface GroqChatResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

// Thin wrapper around Groq's /chat/completions endpoint (OpenAI-compatible request/
// response shape — see https://console.groq.com/docs/api-reference#chat-create).
// Deliberately has no knowledge of prompts, schemas, retries-for-validation, caching,
// or logging — all of that lives in AiGatewayService. This class's only job is "turn
// GroqChatParams into an HTTP call and turn the response (or failure) into
// GroqChatResult (or a thrown AiUnavailableException)", so it's the one place that
// would need to change if we ever pointed this at a different OpenAI-compatible host.
//
// NOTE: this code has not been exercised against a live Groq endpoint — this build
// environment's network egress is restricted to package registries and cannot reach
// api.groq.com. It is written to Groq's documented API contract and covered by tests
// that mock `fetch`, but treat the first real run against a live GROQ_API_KEY as the
// actual integration test.
@Injectable()
export class GroqClient {
  constructor(private config: ConfigService) {}

  private get apiKey(): string {
    return this.config.get<string>("ai.groqApiKey") ?? "";
  }

  private get baseUrl(): string {
    return this.config.get<string>("ai.groqApiBaseUrl")!;
  }

  private get timeoutMs(): number {
    return this.config.get<number>("ai.requestTimeoutMs")!;
  }

  private get maxRetries(): number {
    return this.config.get<number>("ai.maxRetries")!;
  }

  async chat(params: GroqChatParams): Promise<GroqChatResult> {
    if (!this.apiKey) {
      throw new AiUnavailableException("GROQ_API_KEY is not configured");
    }

    let lastError: string = "unknown error";

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            temperature: params.temperature,
            max_tokens: params.maxTokens,
            ...(params.jsonMode ? { response_format: { type: "json_object" } } : {}),
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = response.headers.get("retry-after");
          lastError = `HTTP ${response.status} from Groq`;
          if (attempt < this.maxRetries) {
            const backoffMs = retryAfter ? Number(retryAfter) * 1000 : 500 * 2 ** attempt;
            await sleep(backoffMs);
            continue;
          }
          throw new AiUnavailableException(lastError);
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new AiUnavailableException(`HTTP ${response.status} from Groq: ${body.slice(0, 200)}`);
        }

        const body = (await response.json()) as {
          model: string;
          choices: { message: { content: string } }[];
          usage?: { prompt_tokens: number; completion_tokens: number };
        };

        const content = body.choices[0]?.message?.content;
        if (!content) {
          throw new AiUnavailableException("Groq response had no message content");
        }

        return {
          content,
          model: body.model,
          promptTokens: body.usage?.prompt_tokens ?? 0,
          completionTokens: body.usage?.completion_tokens ?? 0,
        };
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof AiUnavailableException) {
          if (attempt < this.maxRetries && err.message.includes("HTTP 5")) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw err;
        }
        const isAbort = err instanceof Error && err.name === "AbortError";
        lastError = isAbort ? `request timed out after ${this.timeoutMs}ms` : (err as Error).message;
        if (attempt < this.maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
      }
    }

    throw new AiUnavailableException(lastError);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
