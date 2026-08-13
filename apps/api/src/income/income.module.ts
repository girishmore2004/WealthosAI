import { Module } from "@nestjs/common";
import { IncomeController } from "./income.controller";
import { IncomeService } from "./income.service";
import { RecurrenceModule } from "../common/recurrence/recurrence.module";

@Module({
  // RecurrenceModule import is NEW — required so IncomeController can inject
  // RecurrenceGeneratorService for the activate/deactivate/preview endpoints (audit
  // item #3).
  imports: [RecurrenceModule],
  controllers: [IncomeController],
  providers: [IncomeService],
  exports: [IncomeService],
})
export class IncomeModule {}
