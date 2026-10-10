import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength } from "class-validator";
import { Transform } from "class-transformer";

export const EMERGENCY_ENTRY_TYPES = ["ALLOCATE", "RELEASE", "WITHDRAWAL", "ADJUSTMENT", "TRANSFER_IN", "TRANSFER_OUT"] as const;
export type EmergencyEntryTypeDto = (typeof EMERGENCY_ENTRY_TYPES)[number];

// Decimal(14,2) ceiling, same constant the Income/Expense DTOs use.
export const MAX_AMOUNT = 999999999999.99;

export class CreateEmergencyEntryDto {
  @IsEnum(EMERGENCY_ENTRY_TYPES)
  type!: EmergencyEntryTypeDto;

  // Positive for every type except ADJUSTMENT, which is a signed correction. The sign and
  // zero rules are enforced in the service (they depend on `type`).
  @IsNumber({ maxDecimalPlaces: 2 })
  @Max(MAX_AMOUNT)
  amount!: number;

  @IsDateString()
  occurredAt!: string;

  // The source of money added ("Monthly contribution", "Bonus" …) or the reason it was used
  // ("Medical emergency" …). Short; notes holds anything longer.
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  reason?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  notes?: string;
}
