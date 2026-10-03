import { Module } from "@nestjs/common";
import { HouseholdController } from "./household.controller";
import { HouseholdService } from "./household.service";
import { IncomeModule } from "../income/income.module";
import { ExpensesModule } from "../expenses/expenses.module";
import { InvestmentsModule } from "../investments/investments.module";
import { LoansModule } from "../loans/loans.module";
import { PropertyModule } from "../property/property.module";
import { GoalsModule } from "../goals/goals.module";
import { BusinessModule } from "../business/business.module";
import { AlertsModule } from "../alerts/alerts.module";
import { FinancialFactsModule } from "../common/financial-facts/financial-facts.module";

@Module({
  imports: [
    IncomeModule,
    ExpensesModule,
    InvestmentsModule,
    LoansModule,
    PropertyModule,
    GoalsModule,
    BusinessModule,
    AlertsModule,
    FinancialFactsModule,
  ],
  controllers: [HouseholdController],
  providers: [HouseholdService],
})
export class HouseholdModule {}
