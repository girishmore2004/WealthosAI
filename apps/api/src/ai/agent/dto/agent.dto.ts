import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from "class-validator";
import { AGENT_MAX_ATTACHMENTS, AGENT_MAX_MESSAGE_CHARS, MEMORY_MAX_CONTENT_CHARS } from "../agent.constants";
import { interactionContextSchema } from "../agent.types";

export class AgentAttachmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  documentId!: string;
}

export class AgentChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(AGENT_MAX_MESSAGE_CHARS)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  conversationId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AGENT_MAX_ATTACHMENTS)
  @ValidateNested({ each: true })
  @Type(() => AgentAttachmentDto)
  attachments?: AgentAttachmentDto[];

  /** Optional hints from the screen the user is on. Validated strictly and never used to select tools or identities. */
  @IsOptional()
  @IsObject()
  interactionContext?: Record<string, unknown>;
}

export function parseInteractionContext(value: unknown) {
  if (value === undefined) return undefined;
  const parsed = interactionContextSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export class ApprovalDecisionDto {
  @IsIn(["approve", "reject"])
  decision!: "approve" | "reject";
}

export class CorrectMemoryDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(MEMORY_MAX_CONTENT_CHARS)
  content?: string;

  /** Confirming an AI-inferred memory without changing it. */
  @IsOptional()
  @IsIn([true])
  confirm?: true;
}
