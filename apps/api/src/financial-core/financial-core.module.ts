import { Module } from "@nestjs/common";
import { FinancialFactsModule } from "../common/financial-facts/financial-facts.module";
import { FinancialCoreController } from "./financial-core.controller";
import { DataHealthService } from "./data-health/data-health.service";
import { LegacyMigrationService } from "./legacy-migration/legacy-migration.service";
import { EmergencyFundService } from "./emergency-fund/emergency-fund.service";
import { EmergencyFundController } from "./emergency-fund/emergency-fund.controller";

@Module({
  imports: [FinancialFactsModule],
  controllers: [FinancialCoreController, EmergencyFundController],
  providers: [DataHealthService, LegacyMigrationService, EmergencyFundService],
  exports: [DataHealthService, EmergencyFundService],
})
export class FinancialCoreModule {}
