import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { HouseholdModule } from "./household/household.module";
import { IncomeModule } from "./income/income.module";
import { ExpensesModule } from "./expenses/expenses.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { AuditModule } from "./audit/audit.module";
import { InvestmentsModule } from "./investments/investments.module";
import { LoansModule } from "./loans/loans.module";
import { InsuranceModule } from "./insurance/insurance.module";
import { GoalsModule } from "./goals/goals.module";
import { TaxModule } from "./tax/tax.module";
import { RetirementModule } from "./retirement/retirement.module";
import { AlertsModule } from "./alerts/alerts.module";
import { SettingsModule } from "./settings/settings.module";
import { PropertyModule } from "./property/property.module";
import { BusinessModule } from "./business/business.module";
import { DocumentsModule } from "./documents/documents.module";
import { ReportsModule } from "./reports/reports.module";
import { CoachModule } from "./coach/coach.module";
import { SimulatorModule } from "./simulator/simulator.module";
import { AiModule } from "./ai/ai.module";
import { RagModule } from "./ai/rag/rag.module";
import { AgenticCoachModule } from "./ai/coach/agentic-coach.module";
import { ScenarioStudioModule } from "./ai/scenario-studio/scenario-studio.module";
import { MlInsightsModule } from "./ai/ml-insights/ml-insights.module";
import { CopilotIngestionModule } from "./ai/copilot-ingestion/copilot-ingestion.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    RedisModule,
    AuditModule,
    AuthModule,
    UsersModule,
    HouseholdModule,
    IncomeModule,
    ExpensesModule,
    InvestmentsModule,
    LoansModule,
    InsuranceModule,
    GoalsModule,
    TaxModule,
    RetirementModule,
    AlertsModule,
    SettingsModule,
    PropertyModule,
    BusinessModule,
    DocumentsModule,
    ReportsModule,
    CoachModule,
    SimulatorModule,
    DashboardModule,
    AiModule,
    RagModule,
    AgenticCoachModule,
    ScenarioStudioModule,
    MlInsightsModule,
    CopilotIngestionModule,
  ],
})
export class AppModule {}
