import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { createAiQueueConnection } from "../../ai/ops/ai-queue.connection";
import { RecurrenceGeneratorService } from "./recurrence-generator.service";
import { RECURRENCE_QUEUE_NAME } from "./recurrence-scheduler.service";

// Paired with RecurrenceSchedulerService: that service enqueues the repeatable job,
// this one runs it — same split as CoachSchedulerService/CoachProactiveWorker, for the
// same reason (scheduling/enqueueing and processing are different responsibilities).
@Injectable()
export class RecurrenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecurrenceWorker.name);
  private worker: Worker | null = null;
  private connection: Redis | null = null;

  constructor(
    private config: ConfigService,
    private generator: RecurrenceGeneratorService,
  ) {}

  async onModuleInit() {
    try {
      const redisUrl = this.config.get<string>("redisUrl");
      if (!redisUrl) return; // already logged by RecurrenceSchedulerService — no need to warn twice

      this.connection = createAiQueueConnection(redisUrl);
      this.worker = new Worker(
        RECURRENCE_QUEUE_NAME,
        async () => {
          const result = await this.generator.generateAll();
          this.logger.log(
            `Recurring-transaction generation complete: ${result.totalGenerated} row(s) generated across ${result.usersProcessed} user(s).`,
          );
        },
        { connection: this.connection, concurrency: 1 },
      );

      this.worker.on("failed", (job, err) => {
        this.logger.error(`Recurring-transaction generation job ${job?.id} failed: ${err.message}`);
      });
    } catch (err) {
      this.logger.warn(`Failed to start recurring-transaction generation worker, continuing without it: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.worker?.close();
    this.connection?.disconnect();
  }
}
