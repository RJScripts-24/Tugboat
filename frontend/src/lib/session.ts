/**
 * Session cookie shared by the login route, the logout route and every gated
 * page.
 *
 * Stand-in for `POST /auth/login` on the NestJS API (PRD 7.5): same contract -
 * credentials in, httpOnly cookie out - so pointing the form at the real API
 * later changes a URL, not this page. The value below is an opaque demo marker,
 * not yet a JWT; it is deliberately worthless if copied.
 */
export const SESSION_COOKIE = "tugboat_session";

/** Eight hours - long enough for a judging session, short enough to expire. */
export const SESSION_MAX_AGE = 60 * 60 * 8;

export type SignInMode = "credentials" | "demo";

export function sessionValue(mode: SignInMode) {
  return `demo-merchant.${mode}`;
}

/** Which door the session came through - the dashboard says so out loud. */
export function signInModeOf(value: string | undefined): SignInMode | null {
  if (value === sessionValue("demo")) return "demo";
  if (value === sessionValue("credentials")) return "credentials";
  return null;
}
