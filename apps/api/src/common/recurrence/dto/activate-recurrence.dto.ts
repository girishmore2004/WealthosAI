import { IsDateString, IsOptional } from "class-validator";

// Body for POST /income/:id/recurrence/activate and
// POST /expenses/:id/recurrence/activate (audit item #3).
export class ActivateRecurrenceDto {
  // Optional — generation stops once an occurrence would fall on or after this date.
  // Omitted (the common case) means "recur indefinitely until explicitly deactivated."
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
