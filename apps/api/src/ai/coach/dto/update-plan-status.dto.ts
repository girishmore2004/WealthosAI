import { IsIn } from "class-validator";

const STATUSES = ["COMPLETED", "ABANDONED"] as const;

export class UpdatePlanStatusDto {
  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];
}
