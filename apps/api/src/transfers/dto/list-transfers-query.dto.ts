import { IsDateString, IsOptional } from "class-validator";

export class ListTransfersQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
