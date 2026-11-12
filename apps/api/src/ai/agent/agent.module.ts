import { Module } from "@nestjs/common";
import { AiModule } from "../ai.module";
import { RagModule } from "../rag/rag.module";
import { AgenticCoachModule } from "../coach/agentic-coach.module";
import { FinancialEngineModule } from "../financial-engine/financial-engine.module";
import { ScenarioStudioModule } from "../scenario-studio/scenario-studio.module";
import { MlInsightsModule } from "../ml-insights/ml-insights.module";
import { GoalsModule } from "../../goals/goals.module";
import { NumericConsistencyVerifier } from "../coach/verification/numeric-consistency.verifier";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { AgentApprovalService } from "./approval/agent-approval.service";
import { AgentGraphService } from "./graph/agent-graph.service";
import { AgentIntentService } from "./intent/agent-intent.service";
import { AgentMemoryService } from "./memory/agent-memory.service";
import { FinancialSnapshotService } from "./memory/financial-snapshot.service";
import { MemoryConsolidationService } from "./memory/memory-consolidation.service";
import { ActionExtractorService } from "./planning/action-extractor.service";
import { MemoryCryptoService } from "./security/memory-crypto.service";
import { FinancialAuditService } from "./analysis/financial-audit.service";
import { AnalysisToolsService } from "./tools/analysis-tools.service";
import { BuiltinToolsService } from "./tools/builtin-tools.service";
import { ToolRegistryService } from "./tools/tool-registry.service";

// The unified agent. It ADDS an entry point (POST /ai/agent/*) in front of the existing AI services and reuses them as tools; it
// does not replace or modify any of them. PrismaModule is global (PrismaService), and ConfigModule is global.
@Module({
  imports: [AiModule, RagModule, AgenticCoachModule, FinancialEngineModule, ScenarioStudioModule, MlInsightsModule, GoalsModule],
  controllers: [AgentController],
  providers: [
    NumericConsistencyVerifier,
    MemoryCryptoService,
    AgentMemoryService,
    FinancialSnapshotService,
    MemoryConsolidationService,
    ToolRegistryService,
    BuiltinToolsService,
    FinancialAuditService,
    AnalysisToolsService,
    AgentIntentService,
    ActionExtractorService,
    AgentApprovalService,
    AgentGraphService,
    AgentService,
  ],
  exports: [AgentService],
})
export class AgentModule {}
