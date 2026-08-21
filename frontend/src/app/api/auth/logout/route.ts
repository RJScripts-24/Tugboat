import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";

/**
 * POST /api/auth/logout
 *
 * Answers a plain <form> post so signing out works with JavaScript disabled;
 * 303 so the browser follows with a GET.
 */
export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
