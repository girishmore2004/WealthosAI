import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { RagService } from "./rag.service";
import { SearchQueryDto } from "./dto/search-query.dto";
import { AiQueueService } from "../ops/ai-queue.service";
import { PrismaService } from "../../prisma/prisma.service";

// A search is synchronous (unlike indexing) — a user typing a question and hitting
// enter expects an answer in the response, not a job id to poll. It's slower than a
// typical CRUD route (retrieval + rerank + synthesis is up to three model calls) but
// still bounded and interactive-scale; reindexing an entire user's corpus is the
// genuinely long-running operation, which is why *that* goes through the queue.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("ai/search")
export class RagController {
  constructor(
    private rag: RagService,
    private queue: AiQueueService,
    private prisma: PrismaService,
  ) {}

  @Post()
  @RateLimit(20, 3600)
  async search(@CurrentUser() user: User, @Body() dto: SearchQueryDto) {
    return this.rag.search(user.id, dto.query, {
      sourceTypes: dto.sourceTypes,
      dateFrom: dto.dateFrom ? new Date(dto.dateFrom) : undefined,
      dateTo: dto.dateTo ? new Date(dto.dateTo) : undefined,
    });
  }

  @Post("reindex")
  @RateLimit(3, 3600)
  async reindex(@CurrentUser() user: User) {
    // Idempotency key scoped to the current hour — re-clicking "reindex" within the
    // same hour returns the same job instead of queueing a redundant rebuild; a fresh
    // reindex is allowed again the following hour.
    const idempotencyKey = `reindex:${new Date().toISOString().slice(0, 13)}`;
    const job = await this.queue.enqueue("rag.reindex.user", { userId: user.id }, { userId: user.id, idempotencyKey });
    return { jobId: job.id, status: job.status };
  }

  @Get("history")
  @RateLimit(60, 3600)
  async history(@CurrentUser() user: User, @Query("take") take?: string) {
    const limit = Math.min(Number(take) || 20, 50);
    return this.prisma.client.aiSearchLog.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
