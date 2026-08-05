import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { createAiQueueConnection } from "../../ops/ai-queue.connection";

export const COACH_PROACTIVE_QUEUE_NAME = "coach-proactive-checks";
export const COACH_PROACTIVE_JOB_NAME = "daily-scan";

// --- PROACTIVE COACHING SCHEDULE -------------------------------------------------------
//
// Deliberately its OWN Queue (name above) rather than reusing AiQueueService's shared
// "ai-jobs" queue: that queue's processor (ai-queue.processor.ts) looks up an AiJob
// Postgres row by `job.data.jobId` for every job it processes, because AiQueueService
// creates that row before enqueueing. A BullMQ *repeatable* job re-invokes the same
// job data on every tick rather than getting a fresh enqueue() call each time, so it
// would reference a stale/nonexistent AiJob row and fail its bookkeeping update on
// every run after the first. A small dedicated queue with its own worker (see
// coach-proactive.worker.ts) sidesteps that mismatch entirely without needing to
// modify the shared ai-queue infrastructure other features depend on.
//
// Fails soft: if Redis is unreachable at boot, this logs a warning and proactive
// coaching is simply unavailable until the next deploy/restart — it must never take
// down API boot for a feature that is, by design, a background enhancement over the
// synchronous on-demand plan-check path (CoachPlanService.refresh), which keeps
// working regardless.
@Injectable()
export class CoachSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoachSchedulerService.name);
  private queue: Queue | null = null;
  private connection: Redis | null = null;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    try {
      const redisUrl = this.config.get<string>("redisUrl");
      if (!redisUrl) {
        this.logger.warn("No redisUrl configured — proactive coaching daily scan is disabled.");
        return;
      }

      this.connection = createAiQueueConnection(redisUrl);
      this.queue = new Queue(COACH_PROACTIVE_QUEUE_NAME, { connection: this.connection });

      // 08:00 IST daily. BullMQ's repeatable-job dedup (same queue + same jobId +
      // same repeat pattern) makes this call idempotent across API restarts/replicas
      // — it will not create duplicate repeating schedules.
      await this.queue.add(
        COACH_PROACTIVE_JOB_NAME,
        {},
        {
          repeat: { pattern: "0 8 * * *", tz: "Asia/Kolkata" },
          jobId: "coach-proactive-daily-scan",
          removeOnComplete: { count: 30 },
          removeOnFail: { count: 30 },
        },
      );

      this.logger.log("Proactive coaching daily scan scheduled (08:00 IST).");
    } catch (err) {
      this.logger.warn(`Failed to schedule proactive coaching daily scan, continuing without it: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.queue?.close();
    this.connection?.disconnect();
  }
}
