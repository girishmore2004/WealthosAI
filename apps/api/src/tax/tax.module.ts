import { Module } from "@nestjs/common";
import { TaxController } from "./tax.controller";
import { TaxService } from "./tax.service";
import { IncomeModule } from "../income/income.module";

@Module({
  imports: [IncomeModule],
  controllers: [TaxController],
  providers: [TaxService],
  exports: [TaxService],
})
export class TaxModule {}
