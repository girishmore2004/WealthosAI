import { IsDateString, IsOptional, IsString } from "class-validator";

export class CreateMemberDto {
  @IsString()
  name!: string;

  @IsString()
  relation!: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;
}
