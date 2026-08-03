import { Injectable } from "@nestjs/common";
import { AiTaskType } from "./ai-gateway.types";

export interface RoutingStatsSnapshot {
  sampleSize: number;
  /** Fraction of recent calls to this (model, taskType) pair that did NOT return
   * status "OK" (i.e. MALFORMED_FALLBACK or ERROR) — ModelRouterService's accuracy
   * signal. */
  failureRate: number;
  p95LatencyMs: number;
}

type ObservationStatus = "OK" | "MALFORMED_FALLBACK" | "ERROR";

interface Observation {
  status: ObservationStatus;
  latencyMs: number;
}

const WINDOW_SIZE = 200;

// An in-process rolling window of per-(model, taskType) outcomes, fed directly by
// AiGatewayService after every real (non-cached) Groq call. Deliberately NOT backed by
// a query against AiInteractionLog: reading the database on every single routing
// decision would put a query on the hot path of every AI call just to decide which
// model to use for THAT call, defeating the point of routing being cheap. The
// tradeoff, documented here rather than hidden (matching this codebase's convention of
// calling out its own approximations, e.g. TokenBudgetService's token estimate): this
// is process-local. A multi-instance deployment (several Render/Vercel instances) each
// keep their own independent view, so "recent accuracy/latency" really means "as seen
// by whichever instance happens to serve this request" — a fine routing *nudge*
// (worst case, one instance is briefly slower to notice a model degrading), not a
// substitute for the durable, cross-instance truth AiInteractionLog already provides
// for GET /ai/health and any real analytics (see AiLoggingService.recentStats's
// byModel breakdown, which IS DB-backed and cross-instance). If this app moves to a
// shared-cache deployment topology, point this class at Redis instead of an in-memory
// Map and the rest of the routing logic is unaffected.
@Injectable()
export class ModelRoutingStatsService {
  static readonly MIN_SAMPLE_SIZE = 20;

  private windows = new Map<string, Observation[]>();

  private key(model: string, taskType: AiTaskType): string {
    return `${model}::${taskType}`;
  }

  record(model: string, taskType: AiTaskType, status: ObservationStatus, latencyMs: number): void {
    const key = this.key(model, taskType);
    const window = this.windows.get(key) ?? [];
    window.push({ status, latencyMs });
    if (window.length > WINDOW_SIZE) window.shift();
    this.windows.set(key, window);
  }

  getStats(model: string, taskType: AiTaskType): RoutingStatsSnapshot | null {
    const window = this.windows.get(this.key(model, taskType));
    if (!window || window.length === 0) return null;

    const failures = window.filter((o) => o.status !== "OK").length;
    const sortedLatencies = window.map((o) => o.latencyMs).sort((a, b) => a - b);
    const p95Index = Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95));

    return {
      sampleSize: window.length,
      failureRate: Number((failures / window.length).toFixed(3)),
      p95LatencyMs: sortedLatencies[p95Index],
    };
  }

  /** Test/ops utility — no production caller needed today, exposed for a future admin
   * endpoint or for tests that need a clean window between cases. */
  reset(): void {
    this.windows.clear();
  }
}
