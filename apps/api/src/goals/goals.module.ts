import { Module } from "@nestjs/common";
import { FinancialCoreModule } from "../financial-core/financial-core.module";
import { GoalsController } from "./goals.controller";
import { GoalsService } from "./goals.service";

@Module({
  imports: [FinancialCoreModule],
  controllers: [GoalsController],
  providers: [GoalsService],
  exports: [GoalsService],
})
export class GoalsModule {}
