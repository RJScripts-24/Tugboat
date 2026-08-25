import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

import type { SessionClaims } from "./auth.constants";
import type { AuthenticatedRequest } from "./jwt-auth.guard";

/** The verified session claims the guard attached. */
export const CurrentMerchant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionClaims => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.merchant as SessionClaims;
  },
);
