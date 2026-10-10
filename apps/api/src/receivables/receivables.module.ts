import { Module } from "@nestjs/common";
import { ReceivablesController } from "./receivables.controller";
import { ReceivablesService } from "./receivables.service";

// PrismaModule and AuditModule are @Global, so they need no import here.
@Module({
  controllers: [ReceivablesController],
  providers: [ReceivablesService],
  exports: [ReceivablesService],
})
export class ReceivablesModule {}
