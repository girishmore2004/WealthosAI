import { Module } from "@nestjs/common";
import { FinancialFactsModule } from "../common/financial-facts/financial-facts.module";
import { FinancialCoreController } from "./financial-core.controller";
import { DataHealthService } from "./data-health/data-health.service";
import { LegacyMigrationService } from "./legacy-migration/legacy-migration.service";
import { EmergencyFundService } from "./emergency-fund/emergency-fund.service";
import { EmergencyFundController } from "./emergency-fund/emergency-fund.controller";
import { GoalFundingService } from "./goal-funding/goal-funding.service";
import { GoalFundingController } from "./goal-funding/goal-funding.controller";

@Module({
  imports: [FinancialFactsModule],
  controllers: [FinancialCoreController, EmergencyFundController, GoalFundingController],
  providers: [DataHealthService, LegacyMigrationService, EmergencyFundService, GoalFundingService],
  exports: [DataHealthService, EmergencyFundService, GoalFundingService],
})
export class FinancialCoreModule {}
