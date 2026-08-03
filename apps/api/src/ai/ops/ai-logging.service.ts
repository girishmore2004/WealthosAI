import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AiInteractionStatus } from "@wealthos/db";
import { AiTaskType, RoutingReason } from "../gateway/ai-gateway.types";

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
  /** Which cache path served this result — "exact", "semantic", or undefined/null
   * when there was no cache hit at all. See AiCacheService.get/getSemantic. */
  cacheType?: "exact" | "semantic" | null;
  redactedInput: string;
  rawOutput?: string;
  errorMessage?: string;
  /** Real usage as reported by Groq's own `usage` block (GroqClient.chat's return
   * value) — 0 on a cache hit, since no model call was made. Distinct from
   * TokenBudgetService's pre-call ~4-chars-per-token *estimate*, which is never
   * logged here because it was never meant for accounting, only for the trim
   * decision made before the call. */
  promptTokens?: number;
  completionTokens?: number;
  /** Computed by TokenAccountingService from the usage above against
   * config `ai.modelPricing`. null (not 0) when the model isn't in the pricing
   * table — see that class's doc comment for why null is load-bearing here. */
  estimatedCostUsd?: number | null;
  /** Why ModelRouterService picked `model` for this call — see RoutingReason in
   * ai-gateway.types.ts. Always present for real calls; undefined only isn't
   * expected in practice but kept optional so a caller migrating older log-call sites
   * doesn't need to backfill it. */
  routingReason?: RoutingReason;
  /** True when the model that ultimately answered was NOT the router's first-choice
   * candidate — i.e. AiGatewayService had to walk past at least one unavailable
   * model in the chain. See model-router.service.ts's RoutingDecision.chain. */
  fallbackUsed?: boolean;
  /** 0-1, or null when the caller didn't supply `groundingContext` for this call (not
   * measured, not "0 = fully hallucinated"). See GroundingService.score. */
  groundingScore?: number | null;
  hallucinationRisk?: "unmeasured" | "low" | "medium" | "high";
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
          cacheType: params.cacheType ?? null,
          redactedInput: params.redactedInput.slice(0, MAX_STORED_CHARS),
          rawOutput: params.rawOutput?.slice(0, MAX_STORED_CHARS),
          errorMessage: params.errorMessage?.slice(0, MAX_STORED_CHARS),
          promptTokens: params.promptTokens ?? 0,
          completionTokens: params.completionTokens ?? 0,
          estimatedCostUsd: params.estimatedCostUsd ?? null,
          routingReason: params.routingReason ?? null,
          fallbackUsed: params.fallbackUsed ?? false,
          groundingScore: params.groundingScore ?? null,
          hallucinationRisk: params.hallucinationRisk ?? "unmeasured",
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write AiInteractionLog row: ${(err as Error).message}`);
    }
  }

  /** Aggregate stats for the health endpoint — call counts/latency/error-rate/token-
   * spend/model-breakdown over a trailing window. Deliberately reads from the log
   * table rather than pinging Groq live, so polling /ai/health doesn't itself burn
   * model quota. This is the durable, cross-instance counterpart to
   * ModelRoutingStatsService's in-memory, process-local, routing-time-only view — see
   * that class's doc comment for why the two are intentionally separate. */
  async recentStats(sinceMinutesAgo: number) {
    const since = new Date(Date.now() - sinceMinutesAgo * 60_000);
    const rows = await this.prisma.client.aiInteractionLog.findMany({
      where: { createdAt: { gte: since } },
      select: {
        status: true,
        latencyMs: true,
        cacheHit: true,
        model: true,
        promptTokens: true,
        completionTokens: true,
        estimatedCostUsd: true,
        fallbackUsed: true,
        hallucinationRisk: true,
      },
    });

    const total = rows.length;
    const errors = rows.filter((r: { status: string }) => r.status === "ERROR").length;
    const cacheHits = rows.filter((r: { cacheHit: boolean }) => r.cacheHit).length;
    const avgLatencyMs =
      total === 0
        ? null
        : Math.round(rows.reduce((sum: number, r: { latencyMs: number }) => sum + r.latencyMs, 0) / total);

    const totalPromptTokens = rows.reduce(
      (sum: number, r: { promptTokens: number | null }) => sum + (r.promptTokens ?? 0),
      0,
    );
    const totalCompletionTokens = rows.reduce(
      (sum: number, r: { completionTokens: number | null }) => sum + (r.completionTokens ?? 0),
      0,
    );
    const totalCostUsd = rows.reduce(
      (sum: number, r: { estimatedCostUsd: unknown }) => sum + Number(r.estimatedCostUsd ?? 0),
      0,
    );
    const fallbackCount = rows.filter((r: { fallbackUsed: boolean }) => r.fallbackUsed).length;
    const highRiskCount = rows.filter(
      (r: { hallucinationRisk: string | null }) => r.hallucinationRisk === "high",
    ).length;

    const byModel = new Map<string, { calls: number; errors: number; totalLatencyMs: number; costUsd: number }>();
    for (const row of rows as { model: string; status: string; latencyMs: number; estimatedCostUsd: unknown }[]) {
      const entry = byModel.get(row.model) ?? { calls: 0, errors: 0, totalLatencyMs: 0, costUsd: 0 };
      entry.calls += 1;
      if (row.status === "ERROR") entry.errors += 1;
      entry.totalLatencyMs += row.latencyMs;
      entry.costUsd += Number(row.estimatedCostUsd ?? 0);
      byModel.set(row.model, entry);
    }
    const modelBreakdown = Array.from(byModel.entries()).map(([model, s]) => ({
      model,
      calls: s.calls,
      errorRate: Number((s.errors / s.calls).toFixed(3)),
      avgLatencyMs: Math.round(s.totalLatencyMs / s.calls),
      costUsd: Number(s.costUsd.toFixed(6)),
    }));

    return {
      windowMinutes: sinceMinutesAgo,
      totalCalls: total,
      errorCount: errors,
      errorRate: total === 0 ? null : Number((errors / total).toFixed(3)),
      cacheHitRate: total === 0 ? null : Number((cacheHits / total).toFixed(3)),
      avgLatencyMs,
      tokens: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
      },
      estimatedCostUsd: Number(totalCostUsd.toFixed(6)),
      fallbackRate: total === 0 ? null : Number((fallbackCount / total).toFixed(3)),
      highHallucinationRiskCount: highRiskCount,
      byModel: modelBreakdown,
    };
  }
}
