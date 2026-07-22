import { Module } from "@nestjs/common";
import { RetirementController } from "./retirement.controller";
import { RetirementService } from "./retirement.service";

@Module({
  controllers: [RetirementController],
  providers: [RetirementService],
  exports: [RetirementService],
})
export class RetirementModule {}
