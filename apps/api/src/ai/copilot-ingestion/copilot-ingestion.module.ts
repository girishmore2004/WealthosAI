import { Module } from "@nestjs/common";
import { AiModule } from "../ai.module";
import { ExpensesModule } from "../../expenses/expenses.module";
import { MlInsightsModule } from "../ml-insights/ml-insights.module";
import { StatementUnderstandingService } from "./parsing/statement-understanding.service";
import { CategorySuggestionService } from "./merchant/category-suggestion.service";
import { DuplicateDetectionService } from "./detection/duplicate-detection.service";
import { RecurringDetectionService } from "./detection/recurring-detection.service";
import { AnomalyFlaggingService } from "./detection/anomaly-flagging.service";
import { SuggestionScoringService } from "./scoring/suggestion-scoring.service";
import { CopilotIngestionService } from "./copilot-ingestion.service";
import { IngestionReviewService } from "./review/ingestion-review.service";
import { CopilotIngestionController } from "./copilot-ingestion.controller";
import { AnomalyDetectionModel } from "../ml-insights/models/anomaly-detection.model";

// Reuses Phase 14's AnomalyDetectionModel directly (registered again here, same
// reasoning as NumericConsistencyVerifier in ScenarioStudioModule — it's a stateless
// class with no dependencies of its own, cheaper to provide twice than to widen
// MlInsightsModule's exports for one shared class) and MlInsightsModule's
// FeatureExtractionService (exported from that module already, for Phase 12's coach
// integration).
@Module({
  imports: [AiModule, ExpensesModule, MlInsightsModule],
  controllers: [CopilotIngestionController],
  providers: [
    StatementUnderstandingService,
    CategorySuggestionService,
    DuplicateDetectionService,
    RecurringDetectionService,
    AnomalyDetectionModel,
    AnomalyFlaggingService,
    SuggestionScoringService,
    CopilotIngestionService,
    IngestionReviewService,
  ],
  exports: [CopilotIngestionService, IngestionReviewService],
})
export class CopilotIngestionModule {}
