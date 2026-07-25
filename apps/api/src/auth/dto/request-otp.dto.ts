import { IsEmail } from "class-validator";
import { Transform } from "class-transformer";

export class RequestOtpDto {
  // Belt-and-suspenders: AuthService.requestOtp() normalizes independently and is the
  // authoritative source of truth for what "the identifier" is, but normalizing here too
  // means validation errors and logs at the DTO boundary already reflect the normalized
  // form. Requires the global ValidationPipe to be configured with `transform: true`
  // (verify in main.ts / app bootstrap) — if it isn't, this Transform is a no-op and the
  // service-layer normalization alone still guarantees correctness.
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;
}
