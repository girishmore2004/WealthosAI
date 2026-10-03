import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

// POST /insurance/:id/premiums — the single path for recording a premium payment, manual or
// generated, so the two can never produce duplicate expenses. The amount ALWAYS comes from
// the policy (never the client), and `paidAt` defaults to now. `period` is optional: it is
// derived from `paidAt` + the policy's frequency unless an earlier period is being recorded.
export class RecordPremiumDto {
  @IsOptional()
  @IsDateString()
  paidAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  period?: string;
}
