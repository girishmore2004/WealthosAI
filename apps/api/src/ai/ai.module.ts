import { Module } from "@nestjs/common";
import { GroqClient } from "./groq/groq.client";
import { ModelRouterService } from "./gateway/model-router.service";
import { ModelRoutingStatsService } from "./gateway/model-routing-stats.service";
import { TokenAccountingService } from "./gateway/token-accounting.service";
import { GroundingService } from "./gateway/grounding.service";
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
import { RagAutoReindexService } from "./ops/rag-auto-reindex.service";
import { AiHealthController } from "./controllers/ai-health.controller";
import { AiJobsController } from "./controllers/ai-jobs.controller";

// See README "Phase 10 — AI Gateway foundation" for the full design and honest
// limitations (no live-endpoint verification from this build environment, self-
// reported rather than calibrated confidence, in-process worker rather than a
// separate deployment). Every future AI feature module (RAG, Coach 2.0, Scenario
// Studio, Copilot Ingestion) is expected to import AiModule and depend on
// AiGatewayService / AiQueueService rather than reaching for GroqClient directly.
//
// ModelRoutingStatsService, TokenAccountingService, and GroundingService are new
// gateway-internal collaborators (dynamic routing signal, exact cost accounting, and
// grounding/hallucination scoring respectively) — not exported, since nothing outside
// AiGatewayService is expected to call them directly today.
//
// RagAutoReindexService (audit item #7) is a thin wrapper over AiQueueService for
// triggering an incremental RAG reindex after a relevant write — exported here rather
// than living inside RagModule so DocumentsModule/CopilotIngestionModule/CoachModule
// can depend on it without importing the (much heavier) full RagModule, which none of
// them otherwise need.
@Module({
  controllers: [AiHealthController, AiJobsController],
  providers: [
    GroqClient,
    ModelRouterService,
    ModelRoutingStatsService,
    TokenAccountingService,
    GroundingService,
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
    RagAutoReindexService,
  ],
  exports: [AiGatewayService, AiQueueService, AiCacheService, PromptRegistryService, RagAutoReindexService],
})
export class AiModule {}
