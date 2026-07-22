import { Module } from "@nestjs/common";
import { CoachModule } from "../../coach/coach.module";
import { AiModule } from "../ai.module";
import { RagModule } from "../rag/rag.module";
import { GoalsModule } from "../../goals/goals.module";
import { DashboardModule } from "../../dashboard/dashboard.module";
import { AlertsModule } from "../../alerts/alerts.module";
import { LoansModule } from "../../loans/loans.module";
import { InvestmentsModule } from "../../investments/investments.module";
import { RetirementModule } from "../../retirement/retirement.module";
import { ReportsModule } from "../../reports/reports.module";
import { MlInsightsModule } from "../ml-insights/ml-insights.module";
import { IntentClassifierService } from "./planning/intent-classifier.service";
import { PlannerService } from "./planning/planner.service";
import { DataGathererService } from "./gathering/data-gatherer.service";
import { AnswerComposerService } from "./composition/answer-composer.service";
import { NumericConsistencyVerifier } from "./verification/numeric-consistency.verifier";
import { CoachMemoryService } from "./memory/coach-memory.service";
import { AgenticCoachService } from "./agentic-coach.service";
import { AgenticCoachController } from "./agentic-coach.controller";

// This is Phase 12's "explanation layer over the existing deterministic router" —
// CoachModule (Phase 5) is imported for CoachService/matchIntent and is never
// modified by this module; the original /coach/ask and /coach/history endpoints are
// completely unaffected by anything here. This module only adds /coach/v2/*.
@Module({
  imports: [
    CoachModule,
    AiModule,
    RagModule,
    GoalsModule,
    DashboardModule,
    AlertsModule,
    LoansModule,
    InvestmentsModule,
    RetirementModule,
    ReportsModule,
    MlInsightsModule,
  ],
  controllers: [AgenticCoachController],
  providers: [
    IntentClassifierService,
    PlannerService,
    DataGathererService,
    AnswerComposerService,
    NumericConsistencyVerifier,
    CoachMemoryService,
    AgenticCoachService,
  ],
  exports: [AgenticCoachService],
})
export class AgenticCoachModule {}
