import { Module } from "@nestjs/common";
import { ChunkerService } from "./chunking/chunker.service";
import { EmbeddingService } from "./embedding/embedding.service";
import { KeywordScorerService } from "./retrieval/keyword-scorer.service";
import { HybridRetrievalService } from "./retrieval/hybrid-retrieval.service";
import { QueryRewriteService } from "./retrieval/query-rewrite.service";
import { RerankingService } from "./retrieval/reranking.service";
import { AnswerSynthesisService } from "./synthesis/answer-synthesis.service";
import { RagIndexingService } from "./indexing/rag-indexing.service";
import { RagService } from "./rag.service";
import { RagController } from "./rag.controller";
import { ReportsModule } from "../../reports/reports.module";
import { DashboardModule } from "../../dashboard/dashboard.module";
import { AiModule } from "../ai.module";

// Imports AiModule for AiGatewayService/AiQueueService (query rewriting, reranking,
// synthesis, and indexing all call through the gateway; indexing also enqueues/
// registers against the queue). AiModule does NOT import RagModule back — the
// dependency is one-directional, both register independently in AppModule — so
// there's no module cycle to work around here.
@Module({
  imports: [AiModule, ReportsModule, DashboardModule],
  controllers: [RagController],
  providers: [
    ChunkerService,
    EmbeddingService,
    KeywordScorerService,
    HybridRetrievalService,
    QueryRewriteService,
    RerankingService,
    AnswerSynthesisService,
    RagIndexingService,
    RagService,
  ],
  exports: [RagService, RagIndexingService],
})
export class RagModule {}
