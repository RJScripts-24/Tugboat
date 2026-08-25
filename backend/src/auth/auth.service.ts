import { randomBytes } from "node:crypto";

import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { hashPassword, verifyPassword } from "../common/password";
import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  SESSION_MAX_AGE_SECONDS,
  type SessionClaims,
  type SignInMode,
} from "./auth.constants";
import type { LoginDto } from "./dto/login.dto";

export type LoginResult = {
  ok: true;
  mode: SignInMode;
  redirectTo: string;
  accessToken: string;
  expiresInSeconds: number;
  merchant: { id: string; email: string; displayName: string };
};

@Injectable()
export class AuthService {
  /**
   * A hash of a random string nobody can present. Verifying against it keeps
   * the "no such merchant" path as slow as the "wrong password" path — without
   * it, a fast 401 tells an attacker which emails exist.
   */
  private readonly decoyHash = hashPassword(randomBytes(32).toString("hex"));

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResult> {
    const mode: SignInMode = dto.mode === "demo" ? "demo" : "credentials";

    // Single-tenant by design (PRD 6.1): the demo door signs in the one seeded
    // merchant without credentials, which is what the pitch video uses.
    const merchant =
      mode === "demo"
        ? await this.prisma.merchant.findFirst({ orderBy: { createdAt: "asc" } })
        : await this.resolveByCredentials(dto);

    if (!merchant) {
      throw new UnauthorizedException({
        error: "Those credentials don't match the demo merchant.",
      });
    }

    const claims: SessionClaims = {
      sub: merchant.id,
      email: merchant.email,
      name: merchant.displayName,
      mode,
    };

    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.jwtSecret,
      expiresIn: SESSION_MAX_AGE_SECONDS,
    });

    return {
      ok: true,
      mode,
      redirectTo: "/dashboard",
      accessToken,
      expiresInSeconds: SESSION_MAX_AGE_SECONDS,
      merchant: { id: merchant.id, email: merchant.email, displayName: merchant.displayName },
    };
  }

  private async resolveByCredentials(dto: LoginDto) {
    const username = typeof dto.username === "string" ? dto.username.trim() : "";
    const password = typeof dto.password === "string" ? dto.password : "";

    if (!username || !password) {
      throw new BadRequestException({ error: "Enter the merchant username and password." });
    }

    const merchant = await this.prisma.merchant.findUnique({
      where: { email: username.toLowerCase() },
    });

    // Always run a verification, even with no merchant, so both failures cost
    // the same time. The result of the decoy comparison is discarded.
    const matches = await verifyPassword(password, merchant?.passwordHash ?? (await this.decoyHash));

    return merchant && matches ? merchant : null;
  }
}
