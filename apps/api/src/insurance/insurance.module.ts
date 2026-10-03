import { Module } from "@nestjs/common";
import { InsuranceController } from "./insurance.controller";
import { InsuranceService } from "./insurance.service";
import { InsurancePremiumService } from "./insurance-premium.service";
import { IncomeModule } from "../income/income.module";

@Module({
  imports: [IncomeModule],
  controllers: [InsuranceController],
  providers: [InsuranceService, InsurancePremiumService],
  exports: [InsuranceService, InsurancePremiumService],
})
export class InsuranceModule {}
