import { AiUnavailableException } from "../exceptions/ai.exceptions";

/** Races `work` against a timer. On timeout it rejects with AiUnavailableException, which every
 * RAG stage already treats as "use the local fallback". The timer is always cleared, and a late
 * rejection from the abandoned `work` is swallowed so it cannot surface as an unhandled rejection.
 *
 * `work` may be a promise (legacy form: only the wait is bounded) or a function that receives an
 * AbortSignal. The function form is preferred for model calls: when the budget runs out the signal is
 * aborted, so the abandoned call stops instead of continuing in the background (extra provider
 * requests, rate-limit pressure on the stages that follow, and log noise minutes later). */
export async function withStageTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  ms: number,
  stage: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiUnavailableException(`${stage} exceeded its ${ms}ms budget`));
    }, ms);
  });
  const promise = typeof work === "function" ? work(controller.signal) : work;
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
