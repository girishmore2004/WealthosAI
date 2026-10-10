import { PartialType } from "@nestjs/mapped-types";
import { CreateReceivableDto } from "./create-receivable.dto";

// Every field optional. Rules that depend on stored data (amount cannot drop below what has
// already been returned, givenAt cannot move after the first repayment, a cancelled
// receivable is read-only) are enforced in ReceivablesService, not here.
export class UpdateReceivableDto extends PartialType(CreateReceivableDto) {}
