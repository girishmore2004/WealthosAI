import { Module } from "@nestjs/common";
import { BusinessController } from "./business.controller";
import { BusinessService } from "./business.service";
import { IncomeModule } from "../income/income.module";

@Module({
  imports: [IncomeModule],
  controllers: [BusinessController],
  providers: [BusinessService],
  exports: [BusinessService],
})
export class BusinessModule {}
