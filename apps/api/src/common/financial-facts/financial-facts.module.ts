import { Module } from "@nestjs/common";
import { FinancialFactsService } from "./financial-facts.service";
import { IncomeModule } from "../../income/income.module";
import { ExpensesModule } from "../../expenses/expenses.module";

@Module({
  imports: [IncomeModule, ExpensesModule],
  providers: [FinancialFactsService],
  exports: [FinancialFactsService],
})
export class FinancialFactsModule {}
