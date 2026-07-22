import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { IncomeModule } from "../income/income.module";
import { ExpensesModule } from "../expenses/expenses.module";
import { InvestmentsModule } from "../investments/investments.module";
import { LoansModule } from "../loans/loans.module";
import { BusinessModule } from "../business/business.module";

@Module({
  imports: [IncomeModule, ExpensesModule, InvestmentsModule, LoansModule, BusinessModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
