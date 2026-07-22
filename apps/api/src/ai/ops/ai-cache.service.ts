import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../../redis/redis.service";

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
}
