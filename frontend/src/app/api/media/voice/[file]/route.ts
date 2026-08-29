import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { apiBase } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/session";

const FILE_NAME = /^[A-Za-z0-9_-]{1,80}\.(mp3|wav)$/;

/**
 * GET /api/media/voice/<file> — the third BFF route (D-147).
 *
 * A recording lives behind the API's session guard, and a browser will not
 * send one site's httpOnly cookie to another (D-137): on Vercel plus Render
 * the `<audio>` element asked for the file with nothing and got a 401, and
 * the player sat grey at 0:00. This route runs on the Control Tower's own
 * origin, reads the cookie the element cannot, fetches the recording with it
 * and streams the bytes back same-origin. The API's guard is unchanged.
 */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  if (!FILE_NAME.test(file)) {
    return NextResponse.json({ error: "No such recording." }, { status: 404 });
  }

  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}/media/voice/${file}`, {
      headers: { Authorization: `Bearer ${session}` },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the Tugboat API." }, { status: 503 });
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: upstream.status === 404 ? "No such recording." : "The recording is not available." },
      { status: upstream.status === 404 ? 404 : 502 },
    );
  }

  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
    "Cache-Control": "private, max-age=3600",
  });
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);

  return new NextResponse(upstream.body, { status: 200, headers });
}
