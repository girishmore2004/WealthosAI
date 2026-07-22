import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { IncomeModule } from "../income/income.module";
import { ExpensesModule } from "../expenses/expenses.module";
import { InvestmentsModule } from "../investments/investments.module";
import { LoansModule } from "../loans/loans.module";
import { AlertsModule } from "../alerts/alerts.module";
import { PropertyModule } from "../property/property.module";

@Module({
  imports: [IncomeModule, ExpensesModule, InvestmentsModule, LoansModule, AlertsModule, PropertyModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
