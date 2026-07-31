import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";
import { LocalDiskStorageAdapter } from "./adapters/local-disk-storage.adapter";
import { MockOcrAdapter } from "./adapters/mock-ocr.adapter";
import { TesseractOcrAdapter } from "./adapters/tesseract-ocr.adapter";
import { OCR_ADAPTER, ocrAdapterFactory } from "./adapters/ocr-adapter.factory";
import { DocumentOcrHandler } from "./document-ocr.handler";
import { AiModule } from "../ai/ai.module";

@Module({
  // AiModule import is new — required so DocumentOcrHandler can inject AiQueueService,
  // the same shared, generic job-queue infrastructure the AI layer's own health
  // self-test and RAG indexing already register handlers with (AiModule's own doc
  // comment explicitly invites this: "Every future ... module is expected to import
  // AiModule and depend on ... AiQueueService"). No file under apps/api/src/ai is
  // modified to support this — purely a DI wiring addition on the Documents side, the
  // same pattern already used for Property -> Loans and Insurance -> Income.
  imports: [AiModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    LocalDiskStorageAdapter,
    MockOcrAdapter,
    TesseractOcrAdapter,
    // NEW — actually performs OCR asynchronously; see its own doc comment.
    DocumentOcrHandler,
    {
      provide: OCR_ADAPTER,
      useFactory: ocrAdapterFactory,
      inject: [ConfigService, TesseractOcrAdapter, MockOcrAdapter],
    },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
