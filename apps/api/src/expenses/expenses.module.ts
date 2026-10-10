import { Module } from "@nestjs/common";
import { ExpensesController } from "./expenses.controller";
import { ExpensesService } from "./expenses.service";
import { ExpenseRecurrenceEditService } from "./expense-recurrence-edit.service";
import { RecurrenceModule } from "../common/recurrence/recurrence.module";

@Module({
  // RecurrenceModule import is NEW — same rationale as IncomeModule (audit item #3).
  imports: [RecurrenceModule],
  controllers: [ExpensesController],
  providers: [ExpensesService, ExpenseRecurrenceEditService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
