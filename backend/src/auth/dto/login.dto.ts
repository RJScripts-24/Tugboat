import { IsIn, IsOptional, IsString } from "class-validator";

/**
 * Mirrors the body the Control Tower's login form already sends
 * (frontend/src/app/api/auth/login/route.ts): two doors, one session.
 */
export class LoginDto {
  @IsOptional()
  @IsIn(["credentials", "demo"])
  mode?: "credentials" | "demo";

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;
}
