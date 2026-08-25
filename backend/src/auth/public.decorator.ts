import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "tugboat:isPublic";

/**
 * Opens a route to unauthenticated callers. The guard is global and deny-by-
 * default, so a new endpoint is protected unless it says otherwise here —
 * the safe direction for a system that moves money.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
