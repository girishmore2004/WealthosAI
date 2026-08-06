import { Module } from "@nestjs/common";
import { ExpensesModule } from "../../expenses/expenses.module";
import { IncomeModule } from "../../income/income.module";
import { GoalsModule } from "../../goals/goals.module";
import { LoansModule } from "../../loans/loans.module";
import { DashboardModule } from "../../dashboard/dashboard.module";
import { AiModule } from "../ai.module";
import { NumericConsistencyVerifier } from "../coach/verification/numeric-consistency.verifier";
import { FeatureExtractionService } from "./features/feature-extraction.service";
import { AnomalyDetectionModel } from "./models/anomaly-detection.model";
import { CashflowForecastModel } from "./models/cashflow-forecast.model";
import { MetricsForecastModel } from "./models/metrics-forecast.model";
import { DebtRiskModel } from "./models/debt-risk.model";
import { GoalSuccessModel } from "./models/goal-success.model";
import { DriftDetectionModel } from "./models/drift-detection.model";
import { ConceptDriftModel } from "./models/concept-drift.model";
import { FeatureMonitoringModel } from "./models/feature-monitoring.model";
import { HabitSegmentationModel } from "./models/habit-segmentation.model";
import { BehavioralFeaturesModel } from "./models/behavioral-features.model";
import { AnomalyExplanationService } from "./explanation/anomaly-explanation.service";
import { MlInsightsService } from "./ml-insights.service";
import { MlInsightsController } from "./ml-insights.controller";

// UPDATED (Phase 14.1 — advanced probabilistic models): this module now DOES import
// AiModule, for exactly one purpose — AnomalyExplanationService's single LLM call,
// which goes through AiGatewayService.extract() the same way Scenario Studio's
// explainer does (see explanation/anomaly-explanation.service.ts's own doc comment).
// Every other provider below remains real statistics computed in-process (OLS
// regression, Bayesian conjugate updating, MAD/z-scores, PSI, Welch's z-test) — "ML"
// here still means genuine, documented, testable math, not a language-model wrapper;
// the one LLM call that does exist is narrowly scoped to composing a natural-language
// explanation of facts the deterministic models already computed, is grounding-
// verified, and always has a deterministic fallback if it's unavailable.
@Module({
  imports: [ExpensesModule, IncomeModule, GoalsModule, LoansModule, DashboardModule, AiModule],
  controllers: [MlInsightsController],
  providers: [
    FeatureExtractionService,
    AnomalyDetectionModel,
    CashflowForecastModel,
    MetricsForecastModel,
    DebtRiskModel,
    GoalSuccessModel,
    DriftDetectionModel,
    ConceptDriftModel,
    FeatureMonitoringModel,
    HabitSegmentationModel,
    BehavioralFeaturesModel,
    NumericConsistencyVerifier,
    AnomalyExplanationService,
    MlInsightsService,
  ],
  exports: [MlInsightsService, FeatureExtractionService, DriftDetectionModel],
})
export class MlInsightsModule {}
