import { Type } from "class-transformer";
import { IsNumber, IsPositive } from "class-validator";

export class PrepaymentQueryDto {
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  lumpSum!: number;
}
