import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

// Thin key-value wrapper around ioredis, used for server-side sessions and rate limiting.
// Free/self-hosted via docker-compose — no paid cache service required.
@Injectable()
export class RedisService implements OnModuleDestroy {
  public readonly client: Redis;

  constructor(private config: ConfigService) {
    this.client = new Redis(this.config.get<string>("redisUrl")!, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    this.client.connect().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("Redis connection failed — is docker-compose up? Sessions will not persist.", err.message);
    });
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds) {
      await this.client.set(key, value, "EX", ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string) {
    return this.client.get(key);
  }

  async del(key: string) {
    await this.client.del(key);
  }

  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, ttlSeconds);
    }
    return count;
  }

  onModuleDestroy() {
    this.client.disconnect();
  }
}
