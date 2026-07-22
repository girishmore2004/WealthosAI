import { IsString, MaxLength, MinLength } from "class-validator";

export class AskCoachDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  question!: string;
}
