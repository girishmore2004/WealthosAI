import { IsString, MaxLength, MinLength } from "class-validator";

export class AskV2Dto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  question!: string;
}
