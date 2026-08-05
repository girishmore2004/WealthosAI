import { IsIn } from "class-validator";

const STATUSES = ["DONE", "DISMISSED"] as const;

export class UpdateTaskDto {
  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];
}
