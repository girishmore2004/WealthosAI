import { Module } from "@nestjs/common";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";
import { LocalDiskStorageAdapter } from "./adapters/local-disk-storage.adapter";
import { MockOcrAdapter } from "./adapters/mock-ocr.adapter";

@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService, LocalDiskStorageAdapter, MockOcrAdapter],
  exports: [DocumentsService],
})
export class DocumentsModule {}
