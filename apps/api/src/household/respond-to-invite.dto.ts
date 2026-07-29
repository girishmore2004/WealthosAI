import { IsString } from "class-validator";

export class RespondToInviteDto {
  @IsString()
  token!: string;
}
