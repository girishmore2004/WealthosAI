jest.mock("../src/prisma/prisma.service", () => ({ PrismaService: class PrismaService {} }));
jest.mock("@prisma/client", () => ({ ...jest.requireActual("@prisma/client"), PrismaClient: class PrismaClient {} }));

import { AiGatewayService } from "../src/ai/gateway/ai-gateway.service";
import { ModelRouterService } from "../src/ai/gateway/model-router.service";
import { ModelRoutingStatsService } from "../src/ai/gateway/model-routing-stats.service";
import { TokenAccountingService } from "../src/ai/gateway/token-accounting.service";
import { GroundingService } from "../src/ai/gateway/grounding.service";
import { SchemaValidatorService } from "../src/ai/gateway/schema-validator.service";
import { TokenBudgetService } from "../src/ai/gateway/token-budget.service";
import { RedactionService } from "../src/ai/gateway/redaction.service";
import { QueryRewriteService } from "../src/ai/rag/retrieval/query-rewrite.service";
import { RagService } from "../src/ai/rag/rag.service";

const CONFIG: Record<string, unknown> = {
  "ai.smallModel": "s", "ai.largeModel": "l", "ai.fallbackModel": "f", "ai.semanticCacheThreshold": 0.94, "ai.modelPricing": {},
};
function gateway(chat: jest.Mock) {
  return new AiGatewayService(
    { chat } as never,
    new ModelRouterService({ get: (k: string) => CONFIG[k] } as never, new ModelRoutingStatsService()),
    new ModelRoutingStatsService(),
    new TokenAccountingService({ get: (k: string) => CONFIG[k] } as never),
    new GroundingService(), new SchemaValidatorService(), new TokenBudgetService(), new RedactionService(),
    { getActive: jest.fn().mockResolvedValue({ name: "t", version: 1, template: "T" }) } as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getSemantic: jest.fn().mockResolvedValue(null), setSemantic: jest.fn() } as never,
    { get: (k: string) => CONFIG[k] } as never,
  );
}

describe("query rewrite: a model that returns too many phrasings (seen in production logs)", () => {
  it("keeps the first three phrasings instead of discarding the whole rewrite", async () => {
    const chat = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        result: {
          rewrittenQueries: ["home loan emi", "monthly home loan payment", "housing loan installment", "mortgage emi amount"],
          isMultiHop: false, subQuestions: [], queryType: "factual", complexity: "simple",
        },
        confidence: 0.9,
      }),
      model: "s", promptTokens: 1, completionTokens: 1,
    });
    const plan = await new QueryRewriteService(gateway(chat)).plan("user-1", "What is my home loan EMI?");
    expect(chat).toHaveBeenCalledTimes(1); // accepted first time, no retry needed
    expect(plan.planSource).toBe("model");
    expect(plan.rewrittenQueries).toContain("housing loan installment");
    expect(plan.rewrittenQueries).not.toContain("mortgage emi amount");
  });
});

describe("a question about what a document says", () => {
  function build() {
    const engine = { ask: jest.fn().mockResolvedValue({ handled: true, answer: "Your loans total X.", intent: "LOANS", tools: [] }) };
    const prisma = { client: { aiSearchLog: { create: jest.fn().mockResolvedValue({}) } } };
    const plan = { originalQuery: "q", rewrittenQueries: ["q"], isMultiHop: false, subQuestions: [], queryType: "factual", complexity: "simple" };
    const retrieval = { search: jest.fn().mockResolvedValue([]), hasEvidence: jest.fn().mockReturnValue(false) };
    const service = new RagService(prisma as never, { plan: jest.fn().mockResolvedValue(plan) } as never, retrieval as never, { rerank: jest.fn() } as never, { synthesize: jest.fn() } as never, engine as never);
    return { service, engine };
  }

  it("is not answered with the live loan figures, and says plainly when no document is found", async () => {
    const { service, engine } = build();
    const result = await service.search("user-1", "What does my home loan agreement say about prepayment?");
    expect(engine.ask).not.toHaveBeenCalled();
    expect(result.hasEvidence).toBe(false);
    expect(result.answer).not.toMatch(/Your loans total/);
    expect(result.evidenceSufficiency).toBe("insufficient");
  });

  it("still leads with live figures for a question about the user's own numbers", async () => {
    const { service, engine } = build();
    const result = await service.search("user-1", "What is my home loan EMI?");
    expect(engine.ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("Your loans total X.");
  });
});
