import { Module } from "@nestjs/common";
import { FinancialFactsModule } from "../../common/financial-facts/financial-facts.module";
import { FinancialCoreModule } from "../../financial-core/financial-core.module";
import { InsuranceModule } from "../../insurance/insurance.module";
import { LoansModule } from "../../loans/loans.module";
import { ExpensesModule } from "../../expenses/expenses.module";
import { InvestmentsModule } from "../../investments/investments.module";
import { ReceivablesModule } from "../../receivables/receivables.module";
import { FinancialEngineController } from "./financial-engine.controller";
import { FinancialEngineService } from "./financial-engine.service";
import { FinancialToolsService } from "./financial-tools.service";

@Module({
  imports: [FinancialFactsModule, FinancialCoreModule, InsuranceModule, LoansModule, ExpensesModule, InvestmentsModule, ReceivablesModule],
  controllers: [FinancialEngineController],
  providers: [FinancialEngineService, FinancialToolsService],
  exports: [FinancialEngineService, FinancialToolsService],
})
export class FinancialEngineModule {}
