/**
 * The session cookie, now that there is a real API behind it.
 *
 * The contract has not changed and that was the point of writing it this way:
 * credentials in, one httpOnly first-party cookie out, every gated page reading
 * the same name. What changed is the value. It used to be an opaque demo marker
 * that was deliberately worthless if copied; it is now the JWT the NestJS API
 * issues, and the cookie is set by the Next route rather than by the API so it
 * stays first-party and httpOnly (D-4).
 *
 * Nothing here verifies anything. The payload is read without checking the
 * signature, on purpose — this decides only whether to render the shell or
 * redirect to the login page, and the actual authority is the API, which
 * verifies the same token on every request and answers 401 if it does not hold.
 * A frontend that verified would need the signing secret in the Next process,
 * which is a second copy of the one secret worth keeping in one place.
 */
export const SESSION_COOKIE = "tugboat_session";

/** Eight hours — long enough for a judging session, short enough to expire. */
export const SESSION_MAX_AGE = 60 * 60 * 8;

export type SignInMode = "credentials" | "demo";

type SessionClaims = {
  sub?: unknown;
  mode?: unknown;
  exp?: unknown;
};

/**
 * Which door the session came through — the dashboard says so out loud.
 *
 * Returns null for anything that is not a live token, which is what the layout
 * turns into a redirect: no cookie, a malformed one, a cookie left over from
 * the mock layer, or a token whose eight hours are up.
 */
export function signInModeOf(value: string | undefined): SignInMode | null {
  const claims = readClaims(value);
  if (!claims) return null;

  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;

  return claims.mode === "demo" ? "demo" : "credentials";
}

/** The JWT's middle segment, decoded. Never trusted for authority — see above. */
function readClaims(value: string | undefined): SessionClaims | null {
  if (!value) return null;

  const segments = value.split(".");
  if (segments.length !== 3) return null;

  try {
    // base64url → base64, then a padding length the decoder will accept.
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");

    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" ? (parsed as SessionClaims) : null;
  } catch {
    return null;
  }
}
