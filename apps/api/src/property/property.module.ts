import { Module } from "@nestjs/common";
import { PropertyController } from "./property.controller";
import { PropertyService } from "./property.service";
import { LoansModule } from "../loans/loans.module";

@Module({
  // LoansModule import is new — required so PropertyService can inject LoansService for
  // estimateHomeLoanInterestDeduction(), which calls LoansService's existing public
  // amortizationSchedule() method. No Loans feature file itself is modified; this is
  // purely a DI wiring addition on the Property side, the same way InsuranceModule
  // already imports IncomeModule to call IncomeService.
  imports: [LoansModule],
  controllers: [PropertyController],
  providers: [PropertyService],
  exports: [PropertyService],
})
export class PropertyModule {}
