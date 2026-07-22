import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { AiQueueService } from "../ops/ai-queue.service";

@UseGuards(SessionAuthGuard)
@Controller("ai/jobs")
export class AiJobsController {
  constructor(private queue: AiQueueService) {}

  @Get(":id")
  async status(@CurrentUser() user: User, @Param("id") id: string) {
    // AiQueueService.getStatus returns null both when the job doesn't exist and when
    // it exists but belongs to someone else — same 404 either way, so this endpoint
    // never confirms or denies another user's job ID exists (the IDOR pattern this
    // repo has fixed elsewhere — see invoice/quote controllers).
    const job = await this.queue.getStatus(user.id, id);
    if (!job) {
      throw new NotFoundException("Job not found");
    }
    return job;
  }
}
