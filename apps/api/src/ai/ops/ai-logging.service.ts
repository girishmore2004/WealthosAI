import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AiInteractionStatus } from "@wealthos/db";
import { AiTaskType } from "../gateway/ai-gateway.types";

const MAX_STORED_CHARS = 4000;

export interface LogInteractionParams {
  userId?: string;
  feature: string;
  taskType: AiTaskType;
  promptName: string;
  promptVersion: number;
  model: string;
  status: AiInteractionStatus;
  confidence?: number;
  retries: number;
  latencyMs: number;
  cacheHit: boolean;
  redactedInput: string;
  rawOutput?: string;
  errorMessage?: string;
}

@Injectable()
export class AiLoggingService {
  private readonly logger = new Logger(AiLoggingService.name);

  constructor(private prisma: PrismaService) {}

  // Logging failures must never fail the underlying AI call — a write error here would
  // otherwise turn "the model answered fine" into "the user sees a 500", which is
  // strictly worse than just losing one audit row. Errors are logged to stderr instead.
  async log(params: LogInteractionParams): Promise<void> {
    try {
      await this.prisma.client.aiInteractionLog.create({
        data: {
          userId: params.userId,
          feature: params.feature,
          taskType: params.taskType,
          promptName: params.promptName,
          promptVersion: params.promptVersion,
          model: params.model,
          status: params.status,
          confidence: params.confidence,
          retries: params.retries,
          latencyMs: params.latencyMs,
          cacheHit: params.cacheHit,
          redactedInput: params.redactedInput.slice(0, MAX_STORED_CHARS),
          rawOutput: params.rawOutput?.slice(0, MAX_STORED_CHARS),
          errorMessage: params.errorMessage?.slice(0, MAX_STORED_CHARS),
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write AiInteractionLog row: ${(err as Error).message}`);
    }
  }

  /** Aggregate stats for the health endpoint — call counts/latency/error-rate over a
   * trailing window. Deliberately reads from the log table rather than pinging Groq
   * live, so polling /ai/health doesn't itself burn model quota. */
  async recentStats(sinceMinutesAgo: number) {
    const since = new Date(Date.now() - sinceMinutesAgo * 60_000);
    const rows = await this.prisma.client.aiInteractionLog.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, latencyMs: true, cacheHit: true },
    });

    const total = rows.length;
    const errors = rows.filter((r: { status: string }) => r.status === "ERROR").length;
    const cacheHits = rows.filter((r: { cacheHit: boolean }) => r.cacheHit).length;
    const avgLatencyMs =
      total === 0
        ? null
        : Math.round(rows.reduce((sum: number, r: { latencyMs: number }) => sum + r.latencyMs, 0) / total);

    return {
      windowMinutes: sinceMinutesAgo,
      totalCalls: total,
      errorCount: errors,
      errorRate: total === 0 ? null : Number((errors / total).toFixed(3)),
      cacheHitRate: total === 0 ? null : Number((cacheHits / total).toFixed(3)),
      avgLatencyMs,
    };
  }
}
