import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { AiJob } from "@wealthos/db";
import { createAiQueueConnection } from "./ai-queue.connection";

export interface EnqueueOptions {
  userId?: string;
  idempotencyKey?: string;
}

export type AiJobHandler = (input: unknown) => Promise<unknown>;

// Postgres (AiJob table) is the source of truth for "what job exists and what state is
// it in" — the same pattern this repo already uses for Session (Redis is fast-path
// transport/locking, Postgres is what a client actually gets told). BullMQ here is
// purely the transport that gets a job from "enqueued" to "a worker picks it up";
// nothing reads job state back out of BullMQ once AiQueueProcessor has updated the
// AiJob row.
//
// Handlers are registered by name (`registerHandler`) rather than this service having
// any built-in knowledge of what job types exist — RAG indexing, Coach planning runs,
// etc. each register their own handler from their own module once those phases land,
// without needing to modify this file.
@Injectable()
export class AiQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(AiQueueService.name);
  private readonly queue: Queue;
  private readonly handlers = new Map<string, AiJobHandler>();

  constructor(
    private prisma: PrismaService,
    config: ConfigService,
  ) {
    const connection = createAiQueueConnection(config.get<string>("redisUrl")!);
    this.queue = new Queue("ai-jobs", { connection });
  }

  registerHandler(type: string, handler: AiJobHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`AI job handler "${type}" is already registered`);
    }
    this.handlers.set(type, handler);
  }

  getHandler(type: string): AiJobHandler | undefined {
    return this.handlers.get(type);
  }

  get bullQueue(): Queue {
    return this.queue;
  }

  async enqueue(type: string, input: unknown, options: EnqueueOptions = {}): Promise<AiJob> {
    // Idempotency check happens against Postgres, not BullMQ — this is what makes
    // "call enqueue() twice with the same key" safe to do from a retried HTTP request
    // without relying on BullMQ's own (job-id-scoped, not query-friendly) dedup.
    if (options.idempotencyKey) {
      if (options.userId) {
        const existing = await this.prisma.client.aiJob.findUnique({
          where: { userId_idempotencyKey: { userId: options.userId, idempotencyKey: options.idempotencyKey } },
        });
        if (existing) {
          this.logger.log(`Idempotent enqueue: returning existing job ${existing.id} for key ${options.idempotencyKey}`);
          return existing;
        }
      } else {
        // No userId to scope the compound unique key against — fall back to a scan
        // for an anonymous job with this idempotency key instead of querying the
        // compound unique index (which requires a non-null userId).
        const existing = await this.prisma.client.aiJob.findFirst({
          where: { userId: null, idempotencyKey: options.idempotencyKey },
        });
        if (existing) {
          this.logger.log(`Idempotent enqueue: returning existing job ${existing.id} for key ${options.idempotencyKey}`);
          return existing;
        }
      }
    }

    const job = await this.prisma.client.aiJob.create({
      data: {
        userId: options.userId,
        type,
        status: "QUEUED",
        idempotencyKey: options.idempotencyKey,
        input: input as object,
      },
    });

    await this.queue.add(
      type,
      { jobId: job.id, type, input },
      {
        jobId: job.id,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    );

    return job;
  }

  async getStatus(userId: string, jobId: string): Promise<AiJob | null> {
    const job = await this.prisma.client.aiJob.findUnique({ where: { id: jobId } });
    // Scoped ownership check rather than a `where: { id, userId }` query — this way a
    // job that exists but belongs to someone else returns null (404 to the caller)
    // instead of leaking "this ID exists" via a different error shape.
    if (!job || job.userId !== userId) return null;
    return job;
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
