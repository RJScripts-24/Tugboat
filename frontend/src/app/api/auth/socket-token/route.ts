import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { apiBase } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * GET /api/auth/socket-token — the second BFF route (D-137).
 *
 * The realtime handshake authenticates with the session cookie whenever the
 * API and the Control Tower are the same site (D-112). Deployed as Vercel plus
 * Render they are not, and a browser will not send one site's httpOnly cookie
 * to another — so the socket would connect with nothing and be told to go
 * away. This route runs on the Control Tower's own origin, reads the cookie
 * the browser cannot, and trades it at the API for a two-minute token scoped
 * to the socket alone. The browser holds that token for one handshake; every
 * REST route refuses it.
 */
export async function GET() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}/auth/socket-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session}`, Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the Tugboat API." }, { status: 503 });
  }

  const payload = (await upstream.json().catch(() => null)) as { token?: unknown } | null;
  if (!upstream.ok || typeof payload?.token !== "string") {
    return NextResponse.json({ error: "Session expired or invalid." }, { status: 401 });
  }

  return NextResponse.json(
    { token: payload.token },
    { headers: { "Cache-Control": "no-store" } },
  );
}
