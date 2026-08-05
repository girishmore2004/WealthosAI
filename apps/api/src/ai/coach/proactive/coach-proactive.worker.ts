import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { createAiQueueConnection } from "../../ops/ai-queue.connection";
import { ProactiveCoachingService } from "./proactive-coaching.service";
import { COACH_PROACTIVE_QUEUE_NAME } from "./coach-scheduler.service";

// Paired with CoachSchedulerService: that service enqueues the repeatable job, this
// one runs it. Split into two classes (rather than one) for the same reason
// AiQueueService and AiQueueProcessor are split — scheduling/enqueueing and
// processing are different responsibilities, and this mirrors that existing
// convention rather than inventing a new one.
@Injectable()
export class CoachProactiveWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoachProactiveWorker.name);
  private worker: Worker | null = null;
  private connection: Redis | null = null;

  constructor(
    private config: ConfigService,
    private proactive: ProactiveCoachingService,
  ) {}

  async onModuleInit() {
    try {
      const redisUrl = this.config.get<string>("redisUrl");
      if (!redisUrl) return; // already logged by CoachSchedulerService — no need to warn twice

      this.connection = createAiQueueConnection(redisUrl);
      this.worker = new Worker(
        COACH_PROACTIVE_QUEUE_NAME,
        async () => {
          await this.proactive.runDailyChecks();
        },
        { connection: this.connection, concurrency: 1 },
      );

      this.worker.on("failed", (job, err) => {
        this.logger.error(`Proactive coaching daily scan job ${job?.id} failed: ${err.message}`);
      });
    } catch (err) {
      this.logger.warn(`Failed to start proactive coaching worker, continuing without it: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.worker?.close();
    this.connection?.disconnect();
  }
}
