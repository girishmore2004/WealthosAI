import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AiQueueService } from "../ai/ops/ai-queue.service";
import { RagAutoReindexService } from "../ai/ops/rag-auto-reindex.service";
import { DocumentStorageAdapter } from "./adapters/document-storage.adapter";
import { LocalDiskStorageAdapter } from "./adapters/local-disk-storage.adapter";
import { OcrAdapter, OcrNotApplicableError } from "./adapters/ocr.adapter";
import { OCR_ADAPTER } from "./adapters/ocr-adapter.factory";

interface DocumentOcrJobInput {
  documentId: string;
  userId: string;
  category: string;
}

// Registers the "document.ocr" job type with AiQueueService (the same shared,
// generic BullMQ-backed queue infrastructure the AI layer's own health self-test and
// RAG indexing already register handlers with — see AiModule's own doc comment: "Every
// future ... module is expected to ... depend on AiGatewayService / AiQueueService").
// Only AiQueueService's already-public API is used here (registerHandler/enqueue) — no
// file under apps/api/src/ai is modified to support this.
//
// This is what actually moves OCR off the upload request path — the previously flagged
// gap: "OCR runs inline... will not scale to a real (network-latency) OCR provider
// without moving to the existing AI job queue." DocumentsService.upload() now enqueues
// a small, JSON-serializable job ({documentId, userId, category}) instead of awaiting
// OCR inline; this handler does the actual work whenever a worker picks the job up,
// re-reading the already-stored file bytes from disk rather than having the (much
// larger, non-JSON-serializable) file buffer passed through the queue itself.
@Injectable()
export class DocumentOcrHandler implements OnModuleInit {
  private readonly logger = new Logger("DocumentOcrHandler");

  constructor(
    private queue: AiQueueService,
    private prisma: PrismaService,
    @Inject(LocalDiskStorageAdapter) private storage: DocumentStorageAdapter,
    @Inject(OCR_ADAPTER) private ocr: OcrAdapter,
    private ragAutoReindex: RagAutoReindexService,
  ) {}

  onModuleInit() {
    this.queue.registerHandler("document.ocr", async (input) => {
      const { documentId, userId, category } = input as DocumentOcrJobInput;
      return this.process(documentId, userId, category);
    });
  }

  private async process(documentId: string, userId: string, category: string) {
    const document = await this.prisma.client.document.findUnique({ where: { id: documentId } });
    if (!document || document.userId !== userId) {
      // The document was deleted (or somehow doesn't match) between enqueue and this
      // job actually running — nothing to update, and not a failure worth retrying.
      this.logger.warn(`document.ocr job for ${documentId} skipped: document not found or ownership mismatch`);
      return { skipped: true };
    }

    try {
      const buffer = await this.storage.read(document.storageKey);
      const result = await this.ocr.process(buffer, document.mimeType, category);

      await this.prisma.client.document.update({
        where: { id: documentId },
        data: { ocrStatus: "DONE", ocrText: result.text, summary: result.summary },
      });

      // NEW (audit item #7): "reindexing is exclusively user-triggered... nothing in
      // Documents... automatically calls it, so the index can and will go stale."
      // Triggered here — not at upload time — because this is the point where
      // genuinely new indexable content (ocrText) actually exists; an upload-time
      // trigger would risk being suppressed by this one under RagAutoReindexService's
      // hourly idempotency key if both fired within the same hour (a very likely
      // scenario, since OCR typically completes within seconds of upload), leaving
      // the OCR'd text unindexed until the next hour boundary or a manual reindex.
      await this.ragAutoReindex.triggerFor(userId);

      return { ocrStatus: "DONE" };
    } catch (err) {
      if (err instanceof OcrNotApplicableError) {
        await this.prisma.client.document.update({
          where: { id: documentId },
          data: { ocrStatus: "NOT_APPLICABLE", summary: err.message },
        });
        // Still triggered: even without extracted text, the document's metadata
        // (filename, category, tags, and this NOT_APPLICABLE summary) is new,
        // genuinely indexable content that wasn't present at upload time.
        await this.ragAutoReindex.triggerFor(userId);
        return { ocrStatus: "NOT_APPLICABLE" };
      }

      // Best-effort status update — if this itself fails, don't let it mask the
      // original OCR error being rethrown below. Wrapped in try/catch (rather than
      // chaining .catch() directly onto the call) so this stays best-effort even if
      // the underlying call doesn't return a real promise (e.g. a test double).
      try {
        await this.prisma.client.document.update({ where: { id: documentId }, data: { ocrStatus: "FAILED" } });
      } catch {
        // Swallowed intentionally — see comment above.
      }

      // Rethrown (not swallowed) so AiQueueService's own retry (3 attempts, exponential
      // backoff — see enqueue()'s config) and AiJob-level failure logging still see a
      // real failure. If a later retry succeeds, its own DONE update simply supersedes
      // this FAILED one.
      throw err;
    }
  }
}
