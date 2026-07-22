import { Module } from "@nestjs/common";
import { ExpensesModule } from "../../expenses/expenses.module";
import { IncomeModule } from "../../income/income.module";
import { GoalsModule } from "../../goals/goals.module";
import { LoansModule } from "../../loans/loans.module";
import { DashboardModule } from "../../dashboard/dashboard.module";
import { FeatureExtractionService } from "./features/feature-extraction.service";
import { AnomalyDetectionModel } from "./models/anomaly-detection.model";
import { CashflowForecastModel } from "./models/cashflow-forecast.model";
import { DebtRiskModel } from "./models/debt-risk.model";
import { GoalSuccessModel } from "./models/goal-success.model";
import { DriftDetectionModel } from "./models/drift-detection.model";
import { HabitSegmentationModel } from "./models/habit-segmentation.model";
import { MlInsightsService } from "./ml-insights.service";
import { MlInsightsController } from "./ml-insights.controller";

// Deliberately does NOT import AiModule — nothing in this module calls Groq or any
// other model host. That's the point: "ML" here means real statistics computed
// in-process, not a wrapper around a hosted language model. See README "Phase 14".
@Module({
  imports: [ExpensesModule, IncomeModule, GoalsModule, LoansModule, DashboardModule],
  controllers: [MlInsightsController],
  providers: [
    FeatureExtractionService,
    AnomalyDetectionModel,
    CashflowForecastModel,
    DebtRiskModel,
    GoalSuccessModel,
    DriftDetectionModel,
    HabitSegmentationModel,
    MlInsightsService,
  ],
  exports: [MlInsightsService, FeatureExtractionService, DriftDetectionModel],
})
export class MlInsightsModule {}
