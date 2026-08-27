/** Matches frontend/src/lib/session.ts — the BFF sets a cookie of this name. */
export const SESSION_COOKIE = "tugboat_session";

/** Eight hours: long enough for a judging session, short enough to expire. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

export type SignInMode = "credentials" | "demo";

export type SessionClaims = {
  sub: string;
  email: string;
  name: string;
  mode: SignInMode;
  /**
   * Present only on a socket token: a short-lived copy of the session the
   * browser may hold in JavaScript to open the realtime connection when the
   * API is on another site and the httpOnly cookie cannot travel (D-137).
   * A token with this scope is refused by every REST route.
   */
  scope?: "socket";
};

/** Long enough to complete one handshake and its reconnects; useless to steal. */
export const SOCKET_TOKEN_MAX_AGE_SECONDS = 120;
