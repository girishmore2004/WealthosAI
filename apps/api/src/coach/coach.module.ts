import { Module } from "@nestjs/common";
import { CoachController } from "./coach.controller";
import { CoachService } from "./coach.service";
import { GoalsModule } from "../goals/goals.module";
import { TaxModule } from "../tax/tax.module";
import { RetirementModule } from "../retirement/retirement.module";
import { InsuranceModule } from "../insurance/insurance.module";
import { InvestmentsModule } from "../investments/investments.module";
import { ExpensesModule } from "../expenses/expenses.module";
import { LoansModule } from "../loans/loans.module";
import { IncomeModule } from "../income/income.module";
import { DashboardModule } from "../dashboard/dashboard.module";
import { AlertsModule } from "../alerts/alerts.module";

@Module({
  imports: [
    GoalsModule,
    TaxModule,
    RetirementModule,
    InsuranceModule,
    InvestmentsModule,
    ExpensesModule,
    LoansModule,
    IncomeModule,
    DashboardModule,
    AlertsModule,
  ],
  controllers: [CoachController],
  providers: [CoachService],
  exports: [CoachService],
})
export class CoachModule {}
