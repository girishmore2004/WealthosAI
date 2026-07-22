import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { CopilotIngestionService } from "./copilot-ingestion.service";
import { IngestionReviewService } from "./review/ingestion-review.service";
import { IngestStatementDto } from "./dto/ingest-statement.dto";
import { ApproveReviewItemDto } from "./dto/approve-review-item.dto";

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
