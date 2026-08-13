import { PartialType } from "@nestjs/mapped-types";
import { IsDateString, IsOptional } from "class-validator";
import { CreateIncomeDto } from "./create-income.dto";

export class UpdateIncomeDto extends PartialType(CreateIncomeDto) {
  // NEW (audit item #4): when this update changes `amount`, the history entry
  // IncomeService.update() logs uses this as the change's effective date instead of
  // "now" — e.g. "this raise took effect July 1st" even though it's being logged
  // today. Optional; defaults to the moment of the edit when omitted. Has no effect on
  // an update that doesn't change `amount`.
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}
