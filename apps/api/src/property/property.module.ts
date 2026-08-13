import { Module } from "@nestjs/common";
import { PropertyController } from "./property.controller";
import { PropertyService } from "./property.service";
import { LoansModule } from "../loans/loans.module";
import { IncomeModule } from "../income/income.module";

@Module({
  // LoansModule import: required so PropertyService can inject LoansService for
  // estimateHomeLoanInterestDeduction(), which calls LoansService's existing public
  // amortizationSchedule() method. No Loans feature file itself is modified; this is
  // purely a DI wiring addition on the Property side, the same way InsuranceModule
  // already imports IncomeModule to call IncomeService.
  // IncomeModule import: NEW, required so PropertyService can inject IncomeService for
  // enableRentIncomeSync()/disableRentIncomeSync() (audit item #10).
  imports: [LoansModule, IncomeModule],
  controllers: [PropertyController],
  providers: [PropertyService],
  exports: [PropertyService],
})
export class PropertyModule {}
