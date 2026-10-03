import { Module } from "@nestjs/common";
import { InvestmentsController } from "./investments.controller";
import { InvestmentLedgerController } from "./investment-ledger.controller";
import { InvestmentsService } from "./investments.service";
import { InvestmentLedgerService } from "./investment-ledger.service";
import { FinancialFactsModule } from "../common/financial-facts/financial-facts.module";

@Module({
  imports: [FinancialFactsModule],
  controllers: [InvestmentsController, InvestmentLedgerController],
  providers: [InvestmentsService, InvestmentLedgerService],
  exports: [InvestmentsService, InvestmentLedgerService],
})
export class InvestmentsModule {}
