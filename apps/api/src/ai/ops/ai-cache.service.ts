import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../../redis/redis.service";
import {
  SparseVector,
  cosineSimilaritySparse,
  deserializeVector,
  serializeVector,
  toSparseVector,
} from "../gateway/semantic-similarity.util";

// Bounds the semantic cache's per-(feature, promptName, version) recent-entries list —
// see getSemantic/setSemantic below. Deliberately small: this is a recency-biased
// cache of "things asked recently that were close enough to reuse", not a durable
// index, so it doesn't need to hold more than a couple dozen distinct recent inputs
// per prompt to be useful.
const SEMANTIC_CACHE_MAX_ENTRIES = 50;

interface SemanticCacheEntry<T> {
  vector: Record<string, number>;
  value: T;
}

// Reuses the same RedisService every other module already depends on (sessions, rate
// limiting) rather than a separate cache client — one Redis connection to reason
// about, one place a "is Redis down" incident shows up.
@Injectable()
export class AiCacheService {
  constructor(
    private redis: RedisService,
    private config: ConfigService,
  ) {}

  private key(feature: string, promptName: string, promptVersion: number, input: unknown): string {
    // Hash rather than store the raw input in the key so arbitrarily long inputs (e.g.
    // a full document's OCR text) don't produce unbounded Redis key sizes.
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return `ai:cache:${feature}:${promptName}:v${promptVersion}:${hash}`;
  }

  private semanticListKey(feature: string, promptName: string, promptVersion: number): string {
    return `ai:cache:semantic:${feature}:${promptName}:v${promptVersion}`;
  }

  async get<T>(feature: string, promptName: string, promptVersion: number, input: unknown): Promise<T | null> {
    const raw = await this.redis.get(this.key(feature, promptName, promptVersion, input));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(feature: string, promptName: string, promptVersion: number, input: unknown, value: unknown): Promise<void> {
    const ttl = this.config.get<number>("ai.cacheTtlSeconds")!;
    await this.redis.set(this.key(feature, promptName, promptVersion, input), JSON.stringify(value), ttl);
  }

  /** Similarity-based lookup layered on top of the exact-match cache above — see
   * semantic-similarity.util.ts for what "similarity" means here and why it isn't a
   * neural embedding. Scans a small, bounded per-(feature, promptName, version)
   * recent-entries list rather than any kind of vector index: Redis has no built-in
   * vector search, and at the sizes this cache actually holds
   * (SEMANTIC_CACHE_MAX_ENTRIES = 50 per prompt), a linear in-process scan is both
   * simpler and fast enough — this runs once per cacheable call, never in a loop.
   * Fails open to a cache miss (null) on any Redis/parse error, matching get()/set()'s
   * existing contract — AiGatewayService must always be able to treat this as "just
   * call Groq" and never as "the AI feature is down". */
  async getSemantic<T>(
    feature: string,
    promptName: string,
    promptVersion: number,
    inputText: string,
    threshold: number,
  ): Promise<{ value: T; similarity: number } | null> {
    try {
      const listKey = this.semanticListKey(feature, promptName, promptVersion);
      const raw = await this.redis.client.lrange(listKey, 0, SEMANTIC_CACHE_MAX_ENTRIES - 1);
      if (raw.length === 0) return null;

      const queryVector: SparseVector = toSparseVector(inputText);
      let best: { value: T; similarity: number } | null = null;

      for (const entryRaw of raw) {
        let entry: SemanticCacheEntry<T>;
        try {
          entry = JSON.parse(entryRaw);
        } catch {
          continue; // one corrupt entry must not sink the whole lookup
        }
        const similarity = cosineSimilaritySparse(queryVector, deserializeVector(entry.vector));
        if (similarity >= threshold && (!best || similarity > best.similarity)) {
          best = { value: entry.value, similarity };
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  /** Appends this call's result to the small recent-entries list getSemantic() scans.
   * Bounded via LTRIM so the list never grows past SEMANTIC_CACHE_MAX_ENTRIES
   * regardless of call volume, and the whole list carries the same TTL as the
   * exact-match cache (reset on every push — an approximation of true per-entry TTL,
   * acceptable here since a stale entry just costs a few extra Groq calls once it
   * ages out, never a wrong answer, given the high default similarity threshold). */
  async setSemantic(
    feature: string,
    promptName: string,
    promptVersion: number,
    inputText: string,
    value: unknown,
  ): Promise<void> {
    try {
      const ttl = this.config.get<number>("ai.cacheTtlSeconds")!;
      const listKey = this.semanticListKey(feature, promptName, promptVersion);
      const entry: SemanticCacheEntry<unknown> = {
        vector: serializeVector(toSparseVector(inputText)),
        value,
      };
      await this.redis.client.lpush(listKey, JSON.stringify(entry));
      await this.redis.client.ltrim(listKey, 0, SEMANTIC_CACHE_MAX_ENTRIES - 1);
      await this.redis.client.expire(listKey, ttl);
    } catch {
      // Fail-open on the write side too — a missed semantic-cache write just means
      // one fewer future call can be served from cache, never a failed request.
    }
  }
}
