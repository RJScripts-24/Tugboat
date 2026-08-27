"use client";

import { io, type Socket } from "socket.io-client";

/**
 * One socket for the whole Control Tower.
 *
 * A module-level singleton rather than a connection per component, because the
 * shell, the activity log, the pipeline and an open case all want live events
 * at once and four sockets would be four handshakes, four JWT verifications and
 * four copies of every frame. Components subscribe to *concerns*; the transport
 * underneath them is shared and none of them can see it.
 *
 * **Authentication is the session cookie, not a token in JavaScript.** The
 * handshake sends credentials and the gateway verifies the same `tugboat_session`
 * cookie the REST guard accepts. That is why the token is never handed to the
 * browser: an httpOnly cookie a script cannot read is worth keeping, and the one
 * thing that would have forced us to give it up — "the socket needs a token" —
 * turns out not to, because the API and the Control Tower are the same site
 * (D-112).
 *
 * **The socket is an accelerator, never a source.** Every event it carries has
 * an HTTP endpoint that returns the same shape, and every surface below renders
 * correctly from the server before a socket exists. Disconnected, the page stops
 * moving; it never empties, and it never lies.
 */

/**
 * Where the gateway lives, from the browser's side.
 *
 * Public on purpose, unlike `API_URL`: this one is a URL the browser has to
 * dial itself, so it cannot be a server-only secret. It carries no
 * authority — the cookie does — which is what makes publishing it harmless.
 */
const SOCKET_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type Concern = "dashboard" | "approvals" | `case:${string}` | `sim:${string}`;

let socket: Socket | null = null;

/** How many subscribers are holding each concern, so a room is left only when nobody wants it. */
const holders = new Map<Concern, number>();

function connection(): Socket {
  if (socket) return socket;

  socket = io(SOCKET_URL, {
    withCredentials: true,
    // Polling first, then upgrade. The handshake has to carry a cookie and the
    // upgrade path is the reliable way to get one through every proxy in
    // between; a websocket-only client that cannot upgrade simply never
    // connects, and a demo that silently stops moving is the worst failure this
    // layer has.
    transports: ["polling", "websocket"],
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  });

  // A reconnect starts with an empty room list on the server, so everything
  // still being held has to be asked for again. Without this, a laptop that
  // slept through a demo comes back connected and permanently silent.
  socket.on("connect", () => {
    for (const [concern, count] of holders) {
      if (count > 0) socket?.emit("join", { concern });
    }
  });

  return socket;
}

/**
 * Subscribe to one event on one concern.
 *
 * Returns the unsubscribe, which both removes the handler and releases the
 * room. Written for `useEffect`, which is the only place it is called from.
 */
export function subscribe<T>(
  concern: Concern,
  event: string,
  handler: (payload: T) => void,
): () => void {
  const client = connection();

  const held = holders.get(concern) ?? 0;
  holders.set(concern, held + 1);
  // `dashboard` and `approvals` are joined by the gateway on connect; asking
  // again is a no-op, and asking unconditionally is one less special case.
  if (client.connected) client.emit("join", { concern });

  const listener = (payload: T): void => handler(payload);
  client.on(event, listener);

  return () => {
    client.off(event, listener);

    const remaining = (holders.get(concern) ?? 1) - 1;
    holders.set(concern, remaining);
    if (remaining <= 0 && client.connected) client.emit("leave", { concern });
  };
}

/** Whether the transport is up, for the badge that says "live" rather than pretending. */
export function onConnectionChange(handler: (connected: boolean) => void): () => void {
  const client = connection();

  const up = (): void => handler(true);
  const down = (): void => handler(false);

  client.on("connect", up);
  client.on("disconnect", down);
  handler(client.connected);

  return () => {
    client.off("connect", up);
    client.off("disconnect", down);
  };
}
