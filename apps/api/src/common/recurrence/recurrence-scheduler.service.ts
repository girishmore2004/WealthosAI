import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { createAiQueueConnection } from "../../ai/ops/ai-queue.connection";

export const RECURRENCE_QUEUE_NAME = "recurring-transactions-generation";
export const RECURRENCE_JOB_NAME = "daily-generate";

// --- RECURRING-TRANSACTION GENERATION SCHEDULE ------------------------------------
//
// Mirrors CoachSchedulerService's exact pattern (see coach-scheduler.service.ts) for
// the same reason: a dedicated queue with its own worker, not the shared "ai-jobs"
// queue, because a BullMQ *repeatable* job re-invokes the same static job payload on
// every tick, which would conflict with the shared queue's per-invocation AiJob
// Postgres-row bookkeeping.
//
// Scheduled for 03:00 IST — deliberately a different hour than the Coach's 08:00 daily
// scan (and any other scheduled job in the system), so recurring-transaction
// generation always completes well before a user's morning session, and multiple
// scheduled jobs never contend for the same narrow time window.
//
// Fails soft: if Redis is unreachable at boot, this logs a warning and recurring
// generation simply doesn't run on a schedule until the next deploy/restart — it must
// never take down API boot. A user can still trigger generation on demand via
// RecurrenceGeneratorService.generateForUser() (wired to a controller endpoint),
// which keeps working regardless of whether the scheduled job is healthy.
@Injectable()
export class RecurrenceSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecurrenceSchedulerService.name);
  private queue: Queue | null = null;
  private connection: Redis | null = null;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    try {
      const redisUrl = this.config.get<string>("redisUrl");
      if (!redisUrl) {
        this.logger.warn("No redisUrl configured — scheduled recurring-transaction generation is disabled.");
        return;
      }

      this.connection = createAiQueueConnection(redisUrl);
      this.queue = new Queue(RECURRENCE_QUEUE_NAME, { connection: this.connection });

      // 03:00 IST daily. BullMQ's repeatable-job dedup (same queue + same jobId + same
      // repeat pattern) makes this call idempotent across API restarts/replicas — it
      // will not create duplicate repeating schedules.
      await this.queue.add(
        RECURRENCE_JOB_NAME,
        {},
        {
          repeat: { pattern: "0 3 * * *", tz: "Asia/Kolkata" },
          jobId: "recurring-transactions-daily-generate",
          removeOnComplete: { count: 30 },
          removeOnFail: { count: 30 },
        },
      );

      this.logger.log("Recurring-transaction generation scheduled (03:00 IST).");
    } catch (err) {
      this.logger.warn(`Failed to schedule recurring-transaction generation, continuing without it: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.queue?.close();
    this.connection?.disconnect();
  }
}
