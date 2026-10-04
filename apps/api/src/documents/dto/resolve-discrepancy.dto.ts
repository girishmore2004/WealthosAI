import { IsIn } from "class-validator";

export class ResolveDiscrepancyDto {
  // Neither option edits the underlying record. To adopt the document's value, edit the record
  // itself through its normal screen; the discrepancy then closes automatically on re-check.
  @IsIn(["KEEP_DATABASE", "DISMISS"])
  resolution!: "KEEP_DATABASE" | "DISMISS";
}
