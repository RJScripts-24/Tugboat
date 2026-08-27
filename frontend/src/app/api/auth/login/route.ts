import { NextResponse } from "next/server";

import { apiBase } from "@/lib/api";
import { DEMO_MERCHANT } from "@/lib/demo-merchant";
import { SESSION_COOKIE, SESSION_MAX_AGE, type SignInMode } from "@/lib/session";

type LoginBody = {
  mode?: string;
  username?: unknown;
  password?: unknown;
};

/**
 * POST /api/auth/login — the BFF (D-4).
 *
 * This route used to *be* the authentication. It is now a proxy in front of
 * `POST <API>/auth/login`, and the split is deliberate: the API mints and
 * verifies the token, and this route is the only thing that touches the cookie.
 *
 * That is worth one hop. If the browser called the API directly it would have
 * to hold the token somewhere JavaScript can read — `localStorage`, or a
 * non-httpOnly cookie — and any script on the page could then take it. Here the
 * token goes API → Next → httpOnly cookie, and the browser never sees it: every
 * call that needs it is made by a server component through `lib/api.ts`, which
 * reads the cookie server-side.
 *
 * Two doors, one session. The demo door still exists, still says so in the
 * token's `mode` claim, and is still the entry the pitch video uses — but it is
 * now a real login against the seeded merchant rather than a cookie this route
 * wrote by itself, so there is no path into the Control Tower that the API has
 * not authenticated.
 */
export async function POST(request: Request) {
  const body: LoginBody = await request.json().catch(() => ({}));
  const mode: SignInMode = body.mode === "demo" ? "demo" : "credentials";

  const username =
    mode === "demo" ? DEMO_MERCHANT.username : String(readString(body.username) ?? "").trim();
  const password = mode === "demo" ? DEMO_MERCHANT.password : (readString(body.password) ?? "");

  // Kept here rather than deferred to the API so the empty form says "fill this
  // in" instead of "those credentials don't match", which is a different and
  // more useful sentence.
  if (mode === "credentials" && (!username || !password)) {
    return NextResponse.json(
      { error: "Enter the merchant username and password." },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ mode, username, password }),
      cache: "no-store",
    });
  } catch {
    // The commonest development failure, and it deserves its own sentence: a
    // 401 here would send somebody looking for a typo in their password.
    return NextResponse.json(
      { error: "Could not reach the Tugboat API. Is the backend running?" },
      { status: 503 },
    );
  }

  const payload: unknown = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    return NextResponse.json(
      // The API's own wording, deliberately vague about which half was wrong.
      { error: messageOf(payload) ?? "Those credentials don't match the demo merchant." },
      { status: upstream.status },
    );
  }

  const token = tokenOf(payload);
  if (!token) {
    return NextResponse.json(
      { error: "The API accepted the login but issued no session." },
      { status: 502 },
    );
  }

  const response = NextResponse.json({ ok: true, mode, redirectTo: "/dashboard" });

  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    // Lax, not None. The API and the Control Tower are the same site in every
    // arrangement this ships in — two ports on localhost in development, one
    // domain in a deployment — and same-site requests carry a Lax cookie, which
    // is what lets the Socket.IO handshake authenticate with the same session
    // the REST calls use (D-112).
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function tokenOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const token = (payload as { accessToken?: unknown }).accessToken;
  return typeof token === "string" && token ? token : null;
}

function messageOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as { error?: unknown; message?: unknown };
  if (typeof record.error === "string") return record.error;
  if (typeof record.message === "string") return record.message;
  return null;
}
