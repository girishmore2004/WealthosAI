import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { AiLoggingService } from "../ops/ai-logging.service";
import { AiQueueService } from "../ops/ai-queue.service";
import { ConfigService } from "@nestjs/config";

// Unauthenticated on purpose for GET /health — it's read-only, derived entirely from
// aggregate log/queue stats (never per-user data), and is exactly the kind of thing an
// uptime monitor or ops dashboard needs to hit without a session. POST /self-test is
// session-gated and rate-limited since it actually enqueues a job that will call Groq.
@Controller("ai/health")
export class AiHealthController {
  constructor(
    private logging: AiLoggingService,
    private queue: AiQueueService,
    private config: ConfigService,
  ) {}

  @Get()
  async health() {
    const groqConfigured = Boolean(this.config.get<string>("ai.groqApiKey"));
    const stats = await this.logging.recentStats(60);
    const counts = await this.queue.bullQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed");

    return {
      groqConfigured,
      lastHourStats: stats,
      queue: counts,
      // Deliberately does not call Groq live here — see class doc comment. Use
      // POST /ai/health/self-test for an actual end-to-end model call.
      checkedAt: new Date().toISOString(),
    };
  }

  @Post("self-test")
  @UseGuards(SessionAuthGuard, RateLimitGuard)
  @RateLimit(5, 3600)
  async selfTest(@CurrentUser() user: User) {
    const job = await this.queue.enqueue("ai.health.selfTest", { probe: "ping" }, { userId: user.id });
    return { jobId: job.id, status: job.status };
  }
}
