import { IsDateString, IsEnum, IsOptional } from "class-validator";
import { Recurrence } from "@wealthos/db";

// Body for POST /expenses/:id/recurrence/activate (audit item #3). Distinct from
// ActivateRecurrenceDto because Expense has no pre-existing recurrence cadence field
// to reuse (unlike Income) — the cadence must be supplied at activation time.
export class ActivateExpenseRecurrenceDto {
  // ONE_TIME is deliberately excluded at the type level in the service method's
  // signature (Exclude<Recurrence, "ONE_TIME">) — this DTO still accepts the full
  // enum so class-validator can produce a clear 400 for that specific invalid case
  // rather than a generic type-coercion failure.
  @IsEnum(Recurrence)
  recurrence!: Recurrence;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}
