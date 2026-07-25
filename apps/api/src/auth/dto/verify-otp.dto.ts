import { IsEmail, Matches } from "class-validator";
import { Transform } from "class-transformer";

export class VerifyOtpDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  // Previously `@Length(6, 6)` only, which let a 6-character alphanumeric string (e.g.
  // "abcdef") pass DTO validation and fail only later at the hash-comparison stage.
  // Functionally harmless (it could never match a real code hash) but imprecise: this
  // rejects clearly-invalid input with a clean 400 at the validation layer instead of
  // silently falling through to registerFailedAttempt()'s brute-force counter, which
  // should be reserved for genuine guesses against the numeric keyspace.
  @Matches(/^\d{6}$/, { message: "Code must be exactly 6 digits" })
  code!: string;
}
