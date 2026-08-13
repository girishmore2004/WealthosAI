import { Injectable, Logger } from "@nestjs/common";
import { AiQueueService } from "./ai-queue.service";

// Audit item #7: "reindexing is exclusively user-triggered via one controller
// route... nothing in Documents, Copilot Ingestion, Income/Expenses, or the Coach
// automatically calls it, so the index can and will go stale relative to the live app
// state until the user manually re-triggers it." This service is the fix — a single,
// shared helper that every relevant write path calls, instead of each independently
// reimplementing the enqueue call and idempotency-key format.
//
// Reuses the exact same "rag.reindex.user" job type and hourly idempotency-key
// scoping RagController's own manual reindex endpoint already uses (see
// rag.controller.ts's reindex() action) — RagIndexingService's reindex is already
// incremental/delta (only sources whose content hash changed are re-chunked/
// re-embedded, per AiSourceIndexState), so even a "wasted" hourly trigger that finds
// nothing changed is cheap. The hourly window means several writes in quick
// succession (e.g. approving 10 ingestion review items back to back, or a burst of
// Coach interactions) collapse into a single enqueued job, not one per write.
@Injectable()
export class RagAutoReindexService {
  private readonly logger = new Logger(RagAutoReindexService.name);

  constructor(private queue: AiQueueService) {}

  // Best-effort by design: a failed auto-reindex trigger must never fail the write
  // that triggered it (a document upload, an approved ingestion item, a coach
  // answer) — this method swallows and logs rather than throwing. The user can still
  // manually reindex via the existing endpoint if this silently didn't fire, and the
  // next successful auto-trigger (e.g. the user's next document upload) will also
  // catch up on anything missed.
  async triggerFor(userId: string): Promise<void> {
    try {
      const idempotencyKey = `reindex:${new Date().toISOString().slice(0, 13)}`;
      await this.queue.enqueue("rag.reindex.user", { userId }, { userId, idempotencyKey });
    } catch (err) {
      this.logger.warn(`Auto-reindex trigger failed for user ${userId}: ${(err as Error).message}`);
    }
  }
}
