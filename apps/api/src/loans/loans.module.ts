import { Module } from "@nestjs/common";
import { LoansController } from "./loans.controller";
import { LoansService } from "./loans.service";
import { IncomeModule } from "../income/income.module";

@Module({
  imports: [IncomeModule],
  controllers: [LoansController],
  providers: [LoansService],
  exports: [LoansService],
})
export class LoansModule {}
