import { Module } from "@nestjs/common";
import { InvestmentsController } from "./investments.controller";
import { InvestmentLedgerController } from "./investment-ledger.controller";
import { InvestmentsService } from "./investments.service";
import { InvestmentLedgerService } from "./investment-ledger.service";
import { InvestmentProjectionController } from "./investment-projection.controller";
import { InvestmentProjectionService } from "./investment-projection.service";
import { InvestmentAnalyticsService } from "./investment-analytics.service";
import { FinancialFactsModule } from "../common/financial-facts/financial-facts.module";

@Module({
  imports: [FinancialFactsModule],
  controllers: [InvestmentsController, InvestmentLedgerController, InvestmentProjectionController],
  providers: [InvestmentsService, InvestmentLedgerService, InvestmentProjectionService, InvestmentAnalyticsService],
  exports: [InvestmentsService, InvestmentLedgerService, InvestmentAnalyticsService, InvestmentProjectionService],
})
export class InvestmentsModule {}
