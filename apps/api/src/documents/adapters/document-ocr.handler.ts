import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AiQueueService } from "../ai/ops/ai-queue.service";
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
      return { ocrStatus: "DONE" };
    } catch (err) {
      if (err instanceof OcrNotApplicableError) {
        await this.prisma.client.document.update({
          where: { id: documentId },
          data: { ocrStatus: "NOT_APPLICABLE", summary: err.message },
        });
        return { ocrStatus: "NOT_APPLICABLE" };
      }

      // Best-effort status update — if this itself fails, don't let it mask the
      // original OCR error being rethrown below.
      await this.prisma.client.document
        .update({ where: { id: documentId }, data: { ocrStatus: "FAILED" } })
        .catch(() => undefined);

      // Rethrown (not swallowed) so AiQueueService's own retry (3 attempts, exponential
      // backoff — see enqueue()'s config) and AiJob-level failure logging still see a
      // real failure. If a later retry succeeds, its own DONE update simply supersedes
      // this FAILED one.
      throw err;
    }
  }
}
