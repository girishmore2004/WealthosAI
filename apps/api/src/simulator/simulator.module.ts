import { Module } from "@nestjs/common";
import { SimulatorController } from "./simulator.controller";
import { SimulatorService } from "./simulator.service";
import { IncomeModule } from "../income/income.module";
import { ExpensesModule } from "../expenses/expenses.module";
import { InvestmentsModule } from "../investments/investments.module";
import { LoansModule } from "../loans/loans.module";
import { RetirementModule } from "../retirement/retirement.module";
import { GoalsModule } from "../goals/goals.module";

@Module({
  imports: [IncomeModule, ExpensesModule, InvestmentsModule, LoansModule, RetirementModule, GoalsModule],
  controllers: [SimulatorController],
  providers: [SimulatorService],
  exports: [SimulatorService],
})
export class SimulatorModule {}
