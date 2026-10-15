// Bounded execution of one orchestration step: a hard timeout, no retries here (retry policy belongs to the
// capability being called), and a typed outcome so a failed step is DISCLOSED instead of swallowed or turned
// into a fabricated zero.

export type StepOutcome<T> = { ok: true; data: T; ms: number } | { ok: false; reason: string; ms: number };

/** Hard ceiling for any single capability call made on behalf of one Coach question. */
export const STEP_TIMEOUT_MS = 8_000;
/** Scenario simulation can run several internal passes; it gets a longer, still bounded, budget. */
export const SCENARIO_TIMEOUT_MS = 20_000;

export class StepTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = "StepTimeoutError";
  }
}

export async function runStep<T>(label: string, fn: () => Promise<T>, timeoutMs: number = STEP_TIMEOUT_MS): Promise<StepOutcome<T>> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const data = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StepTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
    return { ok: true, data, ms: Date.now() - started };
  } catch (err) {
    // Only the error class and a short message are kept: never request payloads, records or stack traces.
    const reason = err instanceof StepTimeoutError ? "timed out" : err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 160) : "failed";
    return { ok: false, reason, ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Memoises an async loader so the same source is read at most once per Coach question. */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}
