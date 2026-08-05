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
import { TaxModule } from "../../tax/tax.module";
import { MlInsightsModule } from "../ml-insights/ml-insights.module";
import { IntentClassifierService } from "./planning/intent-classifier.service";
import { PlannerService } from "./planning/planner.service";
import { FinancialPlanAgentService } from "./planning/financial-plan-agent.service";
import { DataGathererService } from "./gathering/data-gatherer.service";
import { AnswerComposerService } from "./composition/answer-composer.service";
import { NumericConsistencyVerifier } from "./verification/numeric-consistency.verifier";
import { VerifierAgentService } from "./verification/verifier-agent.service";
import { CriticAgentService } from "./verification/critic-agent.service";
import { CoachMemoryService } from "./memory/coach-memory.service";
import { FinancialMemoryService } from "./memory/financial-memory.service";
import { FinanceCalculatorService } from "./calculation/finance-calculator.service";
import { TaskAgentService } from "./execution/task-agent.service";
import { CoachPlanService } from "./plans/coach-plan.service";
import { PlanMonitorService } from "./plans/plan-monitor.service";
import { ProactiveCoachingService } from "./proactive/proactive-coaching.service";
import { CoachSchedulerService } from "./proactive/coach-scheduler.service";
import { CoachProactiveWorker } from "./proactive/coach-proactive.worker";
import { AgenticCoachService } from "./agentic-coach.service";
import { AgenticCoachController } from "./agentic-coach.controller";

// Phase 20: the multi-agent financial planner over Phase 12's "explanation layer over
// the existing deterministic router". CoachModule (Phase 5) is imported for
// CoachService/matchIntent and is never modified by this module; the original
// /coach/ask and /coach/history endpoints are completely unaffected by anything here.
// This module adds /coach/v2/* (ask, history — Phase 12, unchanged) and /coach/v2/plans,
// /coach/v2/tasks, /coach/v2/nudges (Phase 20, new).
//
// TaxModule and RetirementModule are imported here (in addition to the pre-existing
// Goals/Loans/etc.) so FinanceCalculatorService and PlanMonitorService can inject
// TaxService/RetirementService directly — reusing their deterministic math rather
// than duplicating it, per this feature's Calculator Agent design.
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
    TaxModule,
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
    // --- Phase 20: multi-agent planner ---
    FinancialPlanAgentService, // Planner Agent (persistent plans)
    FinanceCalculatorService, // Calculator Agent
    VerifierAgentService, // Verifier Agent
    CriticAgentService, // Critic Agent
    TaskAgentService, // Execution/Task Agent
    FinancialMemoryService, // persistent financial memory
    CoachPlanService, // controller-facing plan/task/nudge CRUD facade
    PlanMonitorService, // execution monitoring
    ProactiveCoachingService, // proactive coaching scan
    CoachSchedulerService, // schedules the daily proactive scan (BullMQ repeatable job)
    CoachProactiveWorker, // runs the daily proactive scan
  ],
  exports: [AgenticCoachService, CoachPlanService],
})
export class AgenticCoachModule {}
