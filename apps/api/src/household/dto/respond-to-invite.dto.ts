import { IsString, IsNotEmpty } from "class-validator";

export class RespondToInviteDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}
