import { Module } from "@nestjs/common";
import { RecurrenceGeneratorService } from "./recurrence-generator.service";

@Module({
  providers: [RecurrenceGeneratorService],
  exports: [RecurrenceGeneratorService],
})
export class RecurrenceModule {}
