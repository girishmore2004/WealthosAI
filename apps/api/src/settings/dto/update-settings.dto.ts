import { IsBoolean, IsEnum, IsOptional } from "class-validator";
import { DigestFrequency, Theme, AppLanguage } from "@wealthos/db";

export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  notifyEmail?: boolean;

  @IsOptional()
  @IsEnum(DigestFrequency)
  digestFrequency?: DigestFrequency;

  @IsOptional()
  @IsEnum(Theme)
  theme?: Theme;

  @IsOptional()
  @IsEnum(AppLanguage)
  language?: AppLanguage;
}
