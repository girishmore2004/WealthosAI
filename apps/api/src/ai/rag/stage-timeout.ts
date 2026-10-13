import { AiUnavailableException } from "../exceptions/ai.exceptions";

/** Races `work` against a timer. On timeout it rejects with AiUnavailableException, which every
 * RAG stage already treats as "use the local fallback". The timer is always cleared, and a late
 * rejection from the abandoned `work` is swallowed so it cannot surface as an unhandled rejection.
 * Note: this bounds how long the SEARCH waits; the underlying provider call is bounded separately
 * by the Groq client's own request timeout. */
export async function withStageTimeout<T>(work: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiUnavailableException(`${stage} exceeded its ${ms}ms budget`)), ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
