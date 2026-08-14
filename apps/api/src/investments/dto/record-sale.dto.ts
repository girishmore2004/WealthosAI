import { IsDateString, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from "class-validator";
import { MAX_INVESTMENT_AMOUNT } from "./create-investment.dto";

// POST /investments/:id/realized-gains (audit item #11) — an explicit, user-initiated
// action to record a real sale/disposal, NOT something inferred automatically from
// Investment.currentValue changing (a value drop could just be market movement, not
// an actual sale — see capital-gains.util.ts's own doc comment for why this matters).
export class RecordSaleDto {
  @IsDateString()
  saleDate!: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_INVESTMENT_AMOUNT, { message: `proceeds cannot exceed ${MAX_INVESTMENT_AMOUNT}` })
  proceeds!: number;

  // The portion of the investment's cost basis attributable to what was actually
  // sold — for a full disposal this equals the investment's entire current
  // costBasis; for a partial sale, the caller supplies the proportional amount (the
  // service validates this doesn't exceed the investment's total costBasis).
  @IsNumber()
  @IsPositive()
  @Max(MAX_INVESTMENT_AMOUNT, { message: `costBasisPortion cannot exceed ${MAX_INVESTMENT_AMOUNT}` })
  costBasisPortion!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
