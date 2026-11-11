import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { RedisService } from "../../src/redis/redis.service";
import { AiQueueService } from "../../src/ai/ops/ai-queue.service";
import { AgentService } from "../../src/ai/agent/agent.service";
import { AgentController } from "../../src/ai/agent/agent.controller";
import { AgentGraphService } from "../../src/ai/agent/graph/agent-graph.service";
import { BuiltinToolsService } from "../../src/ai/agent/tools/builtin-tools.service";
import { ToolRegistryService } from "../../src/ai/agent/tools/tool-registry.service";

// Compiles the REAL application module graph (so every agent dependency is resolved against the existing modules exactly as in
// production) with only the infrastructure clients replaced. Does not connect to Postgres or Redis.
describe("AgentModule wiring inside AppModule", () => {
  it("resolves all dependencies, mounts /ai/agent and registers every allowlisted tool", async () => {
    const fakeDb = { client: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => [] }) }), onModuleInit: async () => undefined, onModuleDestroy: async () => undefined };
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(fakeDb)
      .overrideProvider(RedisService).useValue({ client: {}, get: async () => null, set: async () => undefined, del: async () => undefined, onModuleDestroy: async () => undefined })
      .overrideProvider(AiQueueService).useValue({ registerHandler: () => undefined, enqueue: async () => undefined, onModuleDestroy: async () => undefined })
      .compile();
    expect(mod.get(AgentController, { strict: false })).toBeDefined();
    expect(mod.get(AgentService, { strict: false })).toBeDefined();
    mod.get(BuiltinToolsService, { strict: false }).onModuleInit();
    mod.get(AgentGraphService, { strict: false }).onModuleInit();
    const names = mod.get(ToolRegistryService, { strict: false }).list().map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["budget_analysis", "coach_advisor", "create_goal", "create_plan", "create_task", "financial_calculator", "financial_database", "financial_engine_answer", "financial_history", "goal_planning", "insurance_analysis", "investment_analysis", "list_tasks", "loan_analysis", "ml_insights", "process_document", "rag_search", "scenario_simulation", "statement_ingestion_status", "update_goal"]);
  }, 90000);
});
