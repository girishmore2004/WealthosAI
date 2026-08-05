import { Module } from "@nestjs/common";
import { AiModule } from "../ai.module";
import { ExpensesModule } from "../../expenses/expenses.module";
import { MlInsightsModule } from "../ml-insights/ml-insights.module";
import { LoansModule } from "../../loans/loans.module";
import { InvestmentsModule } from "../../investments/investments.module";
import { StatementUnderstandingService } from "./parsing/statement-understanding.service";
import { StatementOcrAdapter } from "./parsing/statement-ocr.adapter";
import { OcrQualityEstimationService } from "./parsing/ocr-quality-estimation.service";
import { CategorySuggestionService } from "./merchant/category-suggestion.service";
import { MerchantMemoryService } from "./merchant/merchant-memory.service";
import { CategoryRankingModel } from "./scoring/category-ranking.model";
import { DuplicateDetectionService } from "./detection/duplicate-detection.service";
import { RecurringDetectionService } from "./detection/recurring-detection.service";
import { AnomalyFlaggingService } from "./detection/anomaly-flagging.service";
import { SuggestionScoringService } from "./scoring/suggestion-scoring.service";
import { ReconciliationService } from "./reconciliation/reconciliation.service";
import { CopilotIngestionService } from "./copilot-ingestion.service";
import { IngestionReviewService } from "./review/ingestion-review.service";
import { CopilotIngestionController } from "./copilot-ingestion.controller";
import { AnomalyDetectionModel } from "../ml-insights/models/anomaly-detection.model";
import { EmbeddingService } from "../rag/embedding/embedding.service";

// Reuses Phase 14's AnomalyDetectionModel directly (registered again here, same
// reasoning as NumericConsistencyVerifier in ScenarioStudioModule — it's a stateless
// class with no dependencies of its own, cheaper to provide twice than to widen
// MlInsightsModule's exports for one shared class) and MlInsightsModule's
// FeatureExtractionService (exported from that module already, for Phase 12's coach
// integration).
//
// EmbeddingService (used here by MerchantMemoryService for fuzzy merchant matching) is
// registered again for the exact same reason, with one honestly-documented cost that
// AnomalyDetectionModel doesn't share: EmbeddingService lazily loads an in-process
// ~90MB WASM sentence-embedding model on first use, and RagModule already provides its
// own separate instance of this same class (also not exported — see that module's own
// comment on why extracting a shared leaf module was deferred). Providing it a second
// time here means a production process that exercises both RAG and Copilot Ingestion's
// fuzzy-match path will hold two independently-loaded copies of that model in memory
// rather than one. This is a real, deliberate tradeoff, not an oversight: the
// alternative (widening RagModule's exports, or extracting a new shared leaf module
// both RagModule and this module import) is a cross-feature infrastructure change and
// out of scope for a single-feature change. If the memory cost becomes a real
// production concern, that extraction is the right follow-up.
//
// LoansModule and InvestmentsModule are imported read-only, for ReconciliationService
// to compare statement lines against the user's existing Loan/Investment records — the
// same "import another feature's module for its exported, already-public service"
// pattern ExpensesModule already demonstrates for this module.
@Module({
  imports: [AiModule, ExpensesModule, MlInsightsModule, LoansModule, InvestmentsModule],
  controllers: [CopilotIngestionController],
  providers: [
    StatementUnderstandingService,
    StatementOcrAdapter,
    OcrQualityEstimationService,
    EmbeddingService,
    MerchantMemoryService,
    CategoryRankingModel,
    CategorySuggestionService,
    DuplicateDetectionService,
    RecurringDetectionService,
    AnomalyDetectionModel,
    AnomalyFlaggingService,
    ReconciliationService,
    SuggestionScoringService,
    CopilotIngestionService,
    IngestionReviewService,
  ],
  exports: [CopilotIngestionService, IngestionReviewService],
})
export class CopilotIngestionModule {}
