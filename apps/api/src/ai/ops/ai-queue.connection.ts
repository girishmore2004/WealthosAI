import Redis from "ioredis";

// BullMQ requires its own ioredis connection with maxRetriesPerRequest: null (it
// manages blocking commands and retries itself) — RedisService's connection is tuned
// for the opposite case (fast-failing session/rate-limit lookups) and isn't safe to
// share here. Kept in its own file so AiQueueService and the worker process (if ever
// split into a separate process from the API) both construct it identically.
export function createAiQueueConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
}
