import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { CopilotIngestionService } from "./copilot-ingestion.service";
import { IngestionReviewService } from "./review/ingestion-review.service";
import { IngestStatementDto } from "./dto/ingest-statement.dto";
import { IngestStatementOcrDto } from "./dto/ingest-statement-ocr.dto";
import { ApproveReviewItemDto } from "./dto/approve-review-item.dto";
import { MAX_OCR_IMAGE_SIZE_BYTES, OCR_SUPPORTED_MIME_TYPES } from "./copilot-ingestion.constants";
import { UnsupportedStatementImageError } from "./parsing/statement-ocr.adapter";

@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("copilot-ingestion")
export class CopilotIngestionController {
  constructor(
    private ingestion: CopilotIngestionService,
    private review: IngestionReviewService,
  ) {}

  // Runs a per-line category-suggestion model call for up to MAX_LINES_PER_BATCH
  // lines — meaningfully more expensive than a typical route, rate-limited
  // accordingly.
  @Post("batches")
  @RateLimit(10, 3600)
  async createBatch(@CurrentUser() user: User, @Body() dto: IngestStatementDto) {
    return this.ingestion.ingest(user.id, dto.sourceLabel, dto.rawText, dto.defaultPaymentMethod);
  }

  // OCR + per-line suggestion is strictly more expensive than the text path (adds a
  // Tesseract recognition pass), so it gets its own, tighter rate limit rather than
  // sharing createBatch's.
  @Post("batches/ocr")
  @RateLimit(5, 3600)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_OCR_IMAGE_SIZE_BYTES } }))
  async createBatchFromOcr(@CurrentUser() user: User, @UploadedFile() file: Express.Multer.File, @Body() dto: IngestStatementOcrDto) {
    if (!file) throw new BadRequestException("A statement image file is required.");
    if (!OCR_SUPPORTED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported image type "${file.mimetype}" — upload a JPEG, PNG, or WebP photo/scan of the statement page.`);
    }
    try {
      return await this.ingestion.ingestFromOcr(user.id, dto.sourceLabel, file.buffer, file.mimetype, dto.defaultPaymentMethod);
    } catch (err) {
      if (err instanceof UnsupportedStatementImageError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Get("batches")
  @RateLimit(60, 3600)
  async listBatches(@CurrentUser() user: User, @Query("take") take?: string) {
    return this.ingestion.listBatches(user.id, Math.min(Number(take) || 20, 50));
  }

  @Get("batches/:id")
  @RateLimit(60, 3600)
  async getBatch(@CurrentUser() user: User, @Param("id") id: string) {
    const batch = await this.ingestion.getBatch(user.id, id);
    if (!batch) throw new NotFoundException("Batch not found");
    return batch;
  }

  // Computed live against the user's current Loans/Investments/Expenses rather than a
  // cached batch field — see ReconciliationService for why caching this would go
  // stale as soon as the user edits a Loan/Investment record.
  @Get("batches/:id/reconciliation")
  @RateLimit(30, 3600)
  async getReconciliation(@CurrentUser() user: User, @Param("id") id: string) {
    const report = await this.ingestion.getReconciliationReport(user.id, id);
    if (!report) throw new NotFoundException("Batch not found");
    return report;
  }

  @Post("items/:id/approve")
  @RateLimit(120, 3600)
  async approve(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: ApproveReviewItemDto) {
    const { duplicateResolution, ...edits } = dto;
    return this.review.approve(user.id, id, edits, duplicateResolution);
  }

  @Post("items/:id/reject")
  @RateLimit(120, 3600)
  async reject(@CurrentUser() user: User, @Param("id") id: string) {
    return this.review.reject(user.id, id);
  }
}
