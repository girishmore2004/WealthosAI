import { Module, forwardRef } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { IncomeModule } from "../income/income.module";
import { ExpensesModule } from "../expenses/expenses.module";
import { InvestmentsModule } from "../investments/investments.module";
import { LoansModule } from "../loans/loans.module";
import { AlertsModule } from "../alerts/alerts.module";
import { PropertyModule } from "../property/property.module";
import { FinancialFactsModule } from "../common/financial-facts/financial-facts.module";

@Module({
  imports: [
    IncomeModule,
    ExpensesModule,
    InvestmentsModule,
    LoansModule,
    forwardRef(() => AlertsModule),
    PropertyModule,
    FinancialFactsModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
