import { Module } from "@nestjs/common";
import { RecurrenceGeneratorService } from "./recurrence-generator.service";
import { RecurrenceSchedulerService } from "./recurrence-scheduler.service";
import { RecurrenceWorker } from "./recurrence.worker";

@Module({
  providers: [
    RecurrenceGeneratorService,
    RecurrenceSchedulerService, // schedules the daily generation job (BullMQ repeatable job)
    RecurrenceWorker, // runs the daily generation job
  ],
  exports: [RecurrenceGeneratorService],
})
export class RecurrenceModule {}
