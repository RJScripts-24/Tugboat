import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";

import { AppConfigService } from "../config/app-config.service";
import { SESSION_COOKIE, type SessionClaims } from "./auth.constants";
import { IS_PUBLIC_KEY } from "./public.decorator";

export type AuthenticatedRequest = Request & { merchant?: SessionClaims };

/**
 * Registered globally, so every route is closed unless marked @Public().
 * Accepts the token as a Bearer header or as the session cookie the Control
 * Tower's BFF sets, because both callers are legitimate.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request) ?? cookieToken(request);

    if (!token) {
      throw new UnauthorizedException({ error: "Not signed in." });
    }

    try {
      request.merchant = await this.jwt.verifyAsync<SessionClaims>(token, {
        secret: this.config.jwtSecret,
      });
    } catch {
      throw new UnauthorizedException({ error: "Session expired or invalid." });
    }

    return true;
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}

/** Parsed by hand rather than adding cookie-parser for one cookie. */
function cookieToken(request: Request): string | null {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;

    if (part.slice(0, index).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(index + 1).trim()) || null;
    }
  }

  return null;
}
