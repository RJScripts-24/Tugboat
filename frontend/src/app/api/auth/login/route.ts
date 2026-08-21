import { NextResponse } from "next/server";

import { DEMO_MERCHANT } from "@/lib/demo-merchant";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  sessionValue,
  type SignInMode,
} from "@/lib/session";

type LoginBody = {
  mode?: string;
  username?: unknown;
  password?: unknown;
};

/**
 * POST /api/auth/login
 *
 * Two doors, one session: the credentials form, and the one-click demo entry
 * used in the pitch video. Both end in the same httpOnly cookie, and the cookie
 * records which door was used so the Control Tower can label the session.
 */
export async function POST(request: Request) {
  const body: LoginBody = await request.json().catch(() => ({}));
  const mode: SignInMode = body.mode === "demo" ? "demo" : "credentials";

  if (mode === "credentials") {
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!username || !password) {
      return NextResponse.json(
        { error: "Enter the merchant username and password." },
        { status: 400 },
      );
    }

    const matches =
      username.toLowerCase() === DEMO_MERCHANT.username &&
      password === DEMO_MERCHANT.password;

    if (!matches) {
      // Deliberately vague: never reveal which half was wrong.
      return NextResponse.json(
        { error: "Those credentials don't match the demo merchant." },
        { status: 401 },
      );
    }
  }

  const response = NextResponse.json({ ok: true, mode, redirectTo: "/dashboard" });

  response.cookies.set({
    name: SESSION_COOKIE,
    value: sessionValue(mode),
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}
