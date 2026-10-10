import { IsIn, IsOptional } from "class-validator";

export const RECEIVABLE_SCOPES = ["ALL", "ACTIVE", "CLOSED", "CANCELLED"] as const;
export type ReceivableScope = (typeof RECEIVABLE_SCOPES)[number];

export class ListReceivablesQueryDto {
  // ACTIVE = outstanding or partially returned; CLOSED = fully returned; ALL (default) =
  // everything except cancelled entries.
  @IsOptional()
  @IsIn(RECEIVABLE_SCOPES as unknown as string[])
  scope?: ReceivableScope;
}
