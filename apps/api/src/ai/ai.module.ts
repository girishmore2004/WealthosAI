import { Module } from "@nestjs/common";
import { GroqClient } from "./groq/groq.client";
import { ModelRouterService } from "./gateway/model-router.service";
import { SchemaValidatorService } from "./gateway/schema-validator.service";
import { TokenBudgetService } from "./gateway/token-budget.service";
import { RedactionService } from "./gateway/redaction.service";
import { AiGatewayService } from "./gateway/ai-gateway.service";
import { PromptRegistryService } from "./ops/prompt-registry.service";
import { AiLoggingService } from "./ops/ai-logging.service";
import { AiCacheService } from "./ops/ai-cache.service";
import { AiQueueService } from "./ops/ai-queue.service";
import { AiQueueProcessor } from "./ops/ai-queue.processor";
import { HealthSelfTestHandler } from "./ops/health-self-test.handler";
import { AiHealthController } from "./controllers/ai-health.controller";
import { AiJobsController } from "./controllers/ai-jobs.controller";

// See README "Phase 10 — AI Gateway foundation" for the full design and honest
// limitations (no live-endpoint verification from this build environment, self-
// reported rather than calibrated confidence, in-process worker rather than a
// separate deployment). Every future AI feature module (RAG, Coach 2.0, Scenario
// Studio, Copilot Ingestion) is expected to import AiModule and depend on
// AiGatewayService / AiQueueService rather than reaching for GroqClient directly.
@Module({
  controllers: [AiHealthController, AiJobsController],
  providers: [
    GroqClient,
    ModelRouterService,
    SchemaValidatorService,
    TokenBudgetService,
    RedactionService,
    AiGatewayService,
    PromptRegistryService,
    AiLoggingService,
    AiCacheService,
    AiQueueService,
    AiQueueProcessor,
    HealthSelfTestHandler,
  ],
  exports: [AiGatewayService, AiQueueService, AiCacheService, PromptRegistryService],
})
export class AiModule {}
