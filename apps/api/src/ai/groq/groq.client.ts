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
  jsonMode: boolean;
  signal?: AbortSignal;
  maxRetries?: number;
}

export interface GroqChatResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

type Provider = "openai" | "groq";

@Injectable()
export class GroqClient {
  constructor(private config: ConfigService) {}

  private providerFor(model: string): Provider {
    return model.startsWith("openai:")
      ? "openai"
      : "groq";
  }

  private modelFor(model: string): string {
    return model.replace(/^(openai|groq):/, "");
  }

  private credentialsFor(provider: Provider): {
    apiKey: string;
    baseUrl: string;
  } {
    if (provider === "openai") {
      return {
        apiKey:
          this.config.get<string>("ai.openAiApiKey") ?? "",

        baseUrl:
          this.config.get<string>("ai.openAiApiBaseUrl") ??
          "https://api.openai.com/v1",
      };
    }

    return {
      apiKey:
        this.config.get<string>("ai.groqApiKey") ?? "",

      baseUrl:
        this.config.get<string>("ai.groqApiBaseUrl") ??
        "https://api.groq.com/openai/v1",
    };
  }

  private get timeoutMs(): number {
    return this.config.get<number>(
      "ai.requestTimeoutMs",
    )!;
  }

  private get maxRetries(): number {
    return this.config.get<number>(
      "ai.maxRetries",
    )!;
  }

  async chat(
    params: GroqChatParams,
  ): Promise<GroqChatResult> {
    const provider = this.providerFor(params.model);

    const model = this.modelFor(params.model);

    const { apiKey, baseUrl } =
      this.credentialsFor(provider);

    const providerLabel =
      provider === "openai" ? "OpenAI" : "Groq";

    if (!apiKey) {
      throw new AiUnavailableException(
        `${provider === "openai" ? "OPENAI_API_KEY" : "GROQ_API_KEY"} is not configured`,
      );
    }

    let lastError = "unknown error";

    const maxRetries = Math.max(
      0,
      Math.min(
        params.maxRetries ?? this.maxRetries,
        this.maxRetries,
      ),
    );

    for (
      let attempt = 0;
      attempt <= maxRetries;
      attempt++
    ) {
      if (params.signal?.aborted) {
        throw new AiUnavailableException(
          "request aborted by the caller",
        );
      }

      const controller = new AbortController();

      const timeout = setTimeout(
        () => controller.abort(),
        this.timeoutMs,
      );

      const onCallerAbort = () => controller.abort();

      params.signal?.addEventListener(
        "abort",
        onCallerAbort,
        { once: true },
      );

      try {
        const response = await fetch(
          `${baseUrl.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },

            body: JSON.stringify({
              model,

              messages: params.messages,

              ...openAiParamStyle(
                baseUrl,
                model,
                params.temperature,
                params.maxTokens,
              ),

              ...(params.jsonMode
                ? {
                    response_format: {
                      type: "json_object",
                    },
                  }
                : {}),

              ...(model.startsWith("openai/gpt-oss")
                ? {
                    reasoning_effort: "low",
                  }
                : {}),
            }),

            signal: controller.signal,
          },
        );

        // Rate limit or provider server error.
        if (
          response.status === 429 ||
          response.status >= 500
        ) {
          const retryAfter =
            response.headers.get("retry-after");

          lastError =
            `HTTP ${response.status} from ${providerLabel}`;

          if (attempt < maxRetries) {
            const parsedRetryAfter = Number(retryAfter);

            const backoffMs =
              retryAfter && Number.isFinite(parsedRetryAfter)
                ? Math.min(parsedRetryAfter * 1000, 10000)
                : 500 * 2 ** attempt;

            await sleep(backoffMs, params.signal);

            continue;
          }

          throw new AiUnavailableException(lastError);
        }

        // Authentication, invalid model, or other permanent error.
        if (!response.ok) {
          const body = await response
            .text()
            .catch(() => "");

          throw new AiUnavailableException(
            `HTTP ${response.status} from ${providerLabel}: ${body.slice(0, 200)}`,
          );
        }

        const body = (await response.json()) as {
          model: string;

          choices: {
            message: {
              content: string;
            };
          }[];

          usage?: {
            prompt_tokens: number;
            completion_tokens: number;
          };
        };

        const content =
          body.choices[0]?.message?.content;

        if (!content) {
          throw new AiUnavailableException(
            `${providerLabel} response had no message content`,
          );
        }

        return {
          content,

          model: `${provider}:${body.model}`,

          promptTokens:
            body.usage?.prompt_tokens ?? 0,

          completionTokens:
            body.usage?.completion_tokens ?? 0,
        };
      } catch (err) {
        if (params.signal?.aborted) {
          throw new AiUnavailableException(
            "request aborted by the caller",
          );
        }

        if (err instanceof AiUnavailableException) {
          if (
            attempt < maxRetries &&
            err.message.includes("HTTP 5")
          ) {
            await sleep(
              500 * 2 ** attempt,
              params.signal,
            );

            continue;
          }

          throw err;
        }

        const isAbort =
          err instanceof Error &&
          err.name === "AbortError";

        lastError = isAbort
          ? `request timed out after ${this.timeoutMs}ms`
          : (err as Error).message;

        if (attempt < maxRetries) {
          await sleep(
            500 * 2 ** attempt,
            params.signal,
          );

          continue;
        }
      } finally {
        clearTimeout(timeout);

        params.signal?.removeEventListener(
          "abort",
          onCallerAbort,
        );
      }
    }

    throw new AiUnavailableException(lastError);
  }
}

/**
 * Wait for a retry interval.
 * Stops waiting when the caller aborts.
 */
function sleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener(
        "abort",
        onAbort,
      );

      resolve();
    }, ms);

    signal?.addEventListener(
      "abort",
      onAbort,
      { once: true },
    );
  });
}

/**
 * Provider-specific OpenAI-compatible parameters.
 */
export function openAiParamStyle(
  baseUrl: string,
  model: string,
  temperature: number | undefined,
  maxTokens: number | undefined,
): Record<string, unknown> {
  const isOpenAi =
    /(^|\/\/)api\.openai\.com/i.test(baseUrl);

  const reasoningModel =
    /^(gpt-5|o[134])/i.test(model);

  if (isOpenAi && reasoningModel) {
    return {
      ...(maxTokens !== undefined
        ? {
            max_completion_tokens: maxTokens,
          }
        : {}),
    };
  }

  return {
    temperature,
    max_tokens: maxTokens,
  };
}
