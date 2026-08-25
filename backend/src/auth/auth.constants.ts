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
};
