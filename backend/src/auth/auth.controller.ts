import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";

import type { SessionClaims } from "./auth.constants";
import { AuthService, type LoginResult } from "./auth.service";
import { CurrentMerchant } from "./current-merchant.decorator";
import { LoginDto } from "./dto/login.dto";
import { Public } from "./public.decorator";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Returns the token; it does not set a cookie. The Control Tower's Next.js
   * route owns the cookie so the session stays first-party and httpOnly (D-4),
   * and one owner means one place where its flags can be wrong.
   */
  @Public()
  @Post("login")
  @HttpCode(200)
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto);
  }

  /** Lets the BFF confirm a session is still valid without decoding the JWT itself. */
  @Get("me")
  me(@CurrentMerchant() merchant: SessionClaims) {
    return {
      id: merchant.sub,
      email: merchant.email,
      displayName: merchant.name,
      mode: merchant.mode,
    };
  }
}
