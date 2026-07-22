import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Worker } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { AiQueueService } from "./ai-queue.service";
import { createAiQueueConnection } from "./ai-queue.connection";

interface AiJobData {
  jobId: string;
  type: string;
  input: unknown;
}

// Runs in-process with the API (no separate worker deployment yet — see README "Phase
// 10" for why that's a deliberate, documented simplification, not an oversight). Reads
// `type` off the BullMQ job payload, looks up the matching handler registered via
// AiQueueService.registerHandler, and mirrors the outcome into the AiJob row so
// GET /ai/jobs/:id always reflects reality even though the actual execution happened
// on a queue this endpoint never touches directly.
@Injectable()
export class AiQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiQueueProcessor.name);
  private worker?: Worker;

  constructor(
    private queueService: AiQueueService,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  onModuleInit() {
    const connection = createAiQueueConnection(this.config.get<string>("redisUrl")!);

    this.worker = new Worker(
      "ai-jobs",
      async (job: Job<AiJobData>) => {
        const handler = this.queueService.getHandler(job.data.type);
        if (!handler) {
          throw new Error(`No AI job handler registered for type "${job.data.type}"`);
        }

        await this.prisma.client.aiJob.update({
          where: { id: job.data.jobId },
          data: { status: "RUNNING" },
        });

        const result = await handler(job.data.input);

        await this.prisma.client.aiJob.update({
          where: { id: job.data.jobId },
          data: { status: "DONE", result: result as object, error: null },
        });

        return result;
      },
      { connection, concurrency: 2 },
    );

    this.worker.on("failed", async (job, err) => {
      if (!job) return;
      this.logger.error(`AI job ${job.data.jobId} (${job.data.type}) failed (attempt ${job.attemptsMade}): ${err.message}`);

      // BullMQ fires "failed" after every attempt, not just the last one — a job with
      // attempts: 3 that fails once and then succeeds on retry should never have shown
      // FAILED in between. Only write FAILED once BullMQ has no retries left.
      const attemptsAllowed = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
      if (job.attemptsMade < attemptsAllowed) return;

      try {
        await this.prisma.client.aiJob.update({
          where: { id: job.data.jobId },
          data: { status: "FAILED", error: err.message.slice(0, 2000) },
        });
      } catch (updateErr) {
        this.logger.error(`Failed to write FAILED status for job ${job.data.jobId}: ${(updateErr as Error).message}`);
      }
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
