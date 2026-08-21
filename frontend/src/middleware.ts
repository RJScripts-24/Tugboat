import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";

/**
 * Session routing, moved off the pages.
 *
 * The redirect used to live in `/login` itself via `cookies()`, which forced
 * the route to render dynamically on every request - so the Link could not
 * prefetch it and each click paid for a full server round trip. Deciding here
 * instead lets `/login` be a static page the router can prefetch on hover,
 * which is the difference between an instant navigation and a visible wait.
 *
 * The layout guard behind `(control-tower)` stays as well: middleware is a
 * routing convenience, not the authority on who gets to see a page.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const signedIn = request.cookies.has(SESSION_COOKIE);

  if (pathname === "/login" && signedIn) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (!signedIn && pathname !== "/login") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/login",
    "/dashboard/:path*",
    "/cases/:path*",
    "/approvals/:path*",
    "/simulation/:path*",
    "/audit/:path*",
    "/policies/:path*",
  ],
};
