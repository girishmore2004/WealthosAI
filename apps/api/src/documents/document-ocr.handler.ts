
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AiQueueService } from "../ai/ops/ai-queue.service";
import { RagAutoReindexService } from "../ai/ops/rag-auto-reindex.service";
import { CopilotIngestionService } from "../ai/copilot-ingestion/copilot-ingestion.service";
import { DocumentStorageAdapter } from "./adapters/document-storage.adapter";
import { LocalDiskStorageAdapter } from "./adapters/local-disk-storage.adapter";
import { OcrAdapter, OcrNotApplicableError } from "./adapters/ocr.adapter";
import { OCR_ADAPTER } from "./adapters/ocr-adapter.factory";
import { DocumentReconciliationService } from "./document-reconciliation.service";

interface DocumentOcrJobInput {
  documentId: string;
  userId: string;
  category: string;
}

@Injectable()
export class DocumentOcrHandler implements OnModuleInit {
  private readonly logger = new Logger("DocumentOcrHandler");

  constructor(
    private queue: AiQueueService,
    private prisma: PrismaService,
    @Inject(LocalDiskStorageAdapter)
    private storage: DocumentStorageAdapter,
    @Inject(OCR_ADAPTER)
    private ocr: OcrAdapter,
    private ragAutoReindex: RagAutoReindexService,
    private copilotIngestion: CopilotIngestionService,
    private reconciliation: DocumentReconciliationService,
  ) {}

  onModuleInit(): void {
    this.queue.registerHandler("document.ocr", async (input) => {
      const { documentId, userId, category } =
        input as DocumentOcrJobInput;

      return this.process(documentId, userId, category);
    });
  }

  private async process(
    documentId: string,
    userId: string,
    category: string,
  ) {
    const document = await this.prisma.client.document.findUnique({
      where: { id: documentId },
    });

    if (!document || document.userId !== userId) {
      this.logger.warn(
        `document.ocr job for ${documentId} skipped: document not found or ownership mismatch`,
      );

      return { skipped: true };
    }

    try {
      const buffer = await this.storage.read(document.storageKey);
      const result = await this.ocr.process(
        buffer,
        document.mimeType,
        category,
      );

      // Save the successful OCR result before triggering downstream services.
      await this.prisma.client.document.update({
        where: { id: documentId },
        data: {
          ocrStatus: "DONE",
          ocrText: result.text,
          summary: result.summary,
        },
      });

      // Bridge bank statements into Copilot Ingestion.
      // The ingestion pipeline stages records for user review; it does not
      // automatically create financial transactions.
      if (category === "BANK_STATEMENT") {
        try {
          await this.copilotIngestion.ingestFromDocumentText(
            userId,
            `Bank statement — ${document.fileName}`,
            result.text,
            result.engineConfidence,
            "BANK_TRANSFER",
            documentId,
          );
        } catch (bridgeErr) {
          this.logger.warn(
            `Document-to-Ingestion bridge failed for document ${documentId}: ${
              bridgeErr instanceof Error
                ? bridgeErr.message
                : String(bridgeErr)
            }`,
          );
        }
      }

      // Reconcile linked document facts against stored policy information.
      // Reconciliation is best-effort and must not invalidate a saved OCR result.
      try {
        await this.reconciliation.reconcile(
          userId,
          documentId,
          result.engineConfidence,
        );
      } catch (reconcileErr) {
        this.logger.warn(
          `Document reconciliation failed for ${documentId}: ${
            reconcileErr instanceof Error
              ? reconcileErr.name
              : "UnknownError"
          }`,
        );
      }

      // RAG reindexing is best-effort and user-scoped.
      // IMPORTANT: triggerFor accepts only userId, not documentId.
      await this.ragAutoReindex.triggerFor(userId);

      return { ocrStatus: "DONE" };
    } catch (err) {
      if (err instanceof OcrNotApplicableError) {
        await this.prisma.client.document.update({
          where: { id: documentId },
          data: {
            ocrStatus: "NOT_APPLICABLE",
            summary: err.message,
          },
        });

        // The document metadata can still be indexed even when OCR is unsupported.
        // Keep the existing user-scoped RAG reindex contract.
        await this.ragAutoReindex.triggerFor(userId);

        return { ocrStatus: "NOT_APPLICABLE" };
      }

      // Best-effort failure status update. Never mask the original OCR error.
      try {
        await this.prisma.client.document.update({
          where: { id: documentId },
          data: { ocrStatus: "FAILED" },
        });
      } catch {
        // Preserve the original processing error.
      }

      // Let the queue handle retries and failure logging.
      throw err;
    }
  }
}
