import { IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

export class AskFinancialEngineDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  question!: string;
}
