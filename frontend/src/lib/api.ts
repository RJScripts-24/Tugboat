import { cookies } from "next/headers";

import { SESSION_COOKIE } from "@/lib/session";

/**
 * The one door to the NestJS API.
 *
 * Every `lib/*-data.ts` function goes through this, which is what keeps the
 * integration to one seam: components never learn there is a network, and the
 * page they render does not change shape when the data stops being seeded.
 *
 * Server-side only, deliberately. `API_URL` is not `NEXT_PUBLIC_`, and the
 * session token is in an httpOnly cookie the browser cannot read - so the only
 * place that can call the API is a server component or a route handler, and
 * the token never reaches the client bundle. That is the BFF shape D-4 chose,
 * and this is the file that enforces it rather than merely describing it.
 */

const DEFAULT_BASE = "http://localhost:4000";

export function apiBase(): string {
  return (process.env.API_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
}

/**
 * Raised when the API answers, but not with what was asked for.
 *
 * Carries the status so a caller can tell "no session" from "no such case"
 * from "the backend is down", each of which the Control Tower answers
 * differently.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

type Options = {
  /** Query parameters; `undefined` values are dropped rather than sent empty. */
  query?: Record<string, string | number | boolean | undefined | null>;
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  /**
   * Whether Next may reuse a rendered result.
   *
   * Off by default and on purpose. Every surface here is either a live
   * operational figure or an audit record, and a cached KPI that disagrees
   * with the case list underneath it is the exact failure the event store was
   * built to stop happening inside the browser (`lib/event-store.ts`).
   */
  revalidate?: number | false;
};

function withQuery(path: string, query: Options["query"]): string {
  if (!query) return path;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function apiFetch<T>(path: string, options: Options = {}): Promise<T> {
  const { method = "GET", body, revalidate = false, query } = options;
  const url = `${apiBase()}${withQuery(path, query)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(await authHeader()),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: revalidate === false ? "no-store" : undefined,
      next: revalidate === false ? undefined : { revalidate },
    });
  } catch (cause) {
    // A refused connection is the commonest failure in development and says
    // something specific - the API is not running - which a bare TypeError
    // does not.
    throw new ApiError(0, path, `Could not reach the API at ${apiBase()}: ${(cause as Error).message}`);
  }

  if (!response.ok) {
    throw new ApiError(response.status, path, await errorMessage(response, path));
  }

  return (await response.json()) as T;
}

/** The API's own message when it sent one, so a 4xx explains itself. */
async function errorMessage(response: Response, path: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `${response.status} from ${path}`;

  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const detail = parsed.message ?? parsed.error;
    if (typeof detail === "string") return `${response.status} from ${path}: ${detail}`;
    if (Array.isArray(detail)) return `${response.status} from ${path}: ${detail.join("; ")}`;
  } catch {
    // Not JSON — fall through to the raw body, truncated.
  }

  return `${response.status} from ${path}: ${text.slice(0, 200)}`;
}
