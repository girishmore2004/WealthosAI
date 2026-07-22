import { Module } from "@nestjs/common";
import { AlertsController } from "./alerts.controller";
import { AlertsService } from "./alerts.service";
import { LoansModule } from "../loans/loans.module";
import { InsuranceModule } from "../insurance/insurance.module";
import { GoalsModule } from "../goals/goals.module";
import { ExpensesModule } from "../expenses/expenses.module";
import { BusinessModule } from "../business/business.module";
import { DocumentsModule } from "../documents/documents.module";

@Module({
  imports: [LoansModule, InsuranceModule, GoalsModule, ExpensesModule, BusinessModule, DocumentsModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
