import { Logger } from "@nestjs/common";
import Redis, { RedisOptions } from "ioredis";

const logger = new Logger("Redis");

/** Connection options shared by every ioredis client in the API (this file and RedisService), so a hosted Redis
 * behaves the same everywhere.
 *
 * Why these matter on a hosted Redis (Render Key Value, Upstash, ...): the provider drops idle TLS connections, and
 * a reconnect that then hangs surfaced as raw "Error: connect ETIMEDOUT" stack traces — one per client, repeating —
 * because no client had an 'error' listener. A listener (see attachRedisErrorLogging) turns those into one short,
 * throttled warning line; keepAlive stops the idle drops; the explicit connectTimeout and capped backoff make
 * reconnects prompt instead of waiting on the 10s default and an ever-growing delay. */
export const REDIS_RESILIENCE_OPTIONS: RedisOptions = {
  connectTimeout: 20_000,
  keepAlive: 10_000,
  // Retry forever with a short, capped backoff (200ms, 400ms ... 5s). Giving up would leave the client dead until a restart.
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  // A failover promotes a replica: the old primary answers READONLY. Reconnect (and resend) instead of failing.
  reconnectOnError: (err: Error) => err.message.includes("READONLY"),
};

const ERROR_LOG_INTERVAL_MS = 30_000;

/** Registers the 'error' listener ioredis needs (an emitter with no listener logs a full stack on every failure)
 * and logs at most one line per 30 seconds per client, so an outage is visible without flooding the log.
 * Returns the same client so it can wrap a constructor call. */
export function attachRedisErrorLogging<T extends Redis>(client: T, label: string): T {
  let lastLoggedAt = 0;
  let suppressed = 0;
  client.on("error", (err: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) {
      suppressed++;
      return;
    }
    const extra = suppressed > 0 ? ` (${suppressed} similar error(s) suppressed)` : "";
    lastLoggedAt = now;
    suppressed = 0;
    logger.warn(`${label} connection error: ${err.message}${extra}. Reconnecting automatically.`);
  });
  client.on("ready", () => {
    if (lastLoggedAt > 0) logger.log(`${label} connection restored`);
    lastLoggedAt = 0;
    suppressed = 0;
  });
  return client;
}

// BullMQ requires its own ioredis connection with maxRetriesPerRequest: null (it
// manages blocking commands and retries itself) — RedisService's connection is tuned
// for the opposite case (fast-failing session/rate-limit lookups) and isn't safe to
// share here. Kept in its own file so AiQueueService and the worker process (if ever
// split into a separate process from the API) both construct it identically.
export function createAiQueueConnection(redisUrl: string): Redis {
  return attachRedisErrorLogging(
    new Redis(redisUrl, {
      ...REDIS_RESILIENCE_OPTIONS,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    }),
    "Queue",
  );
}
