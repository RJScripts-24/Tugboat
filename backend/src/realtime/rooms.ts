/**
 * Room names, in one place.
 *
 * Every room is prefixed with the merchant it belongs to. That is not tidiness:
 * Socket.IO rooms are a flat global namespace, so an unprefixed `case:C-12`
 * would deliver one merchant's case to another merchant's browser the day a
 * second merchant exists — and the schema has carried `merchant_id` since Stage
 * 1 precisely so that day is a migration rather than a rewrite. The prefix
 * makes the isolation structural instead of a filter somebody has to remember.
 */

export type Concern = "dashboard" | "approvals" | `case:${string}` | `sim:${string}`;

export function roomFor(merchantId: string, concern: Concern): string {
  return `m:${merchantId}:${concern}`;
}

/** The two a browser always wants: the feed, and the badge on every page. */
export const DEFAULT_CONCERNS: Concern[] = ["dashboard", "approvals"];

const CASE_ROOM = /^case:C-\d+$/;
const SIM_ROOM = /^sim:[A-Za-z0-9-]{1,40}$/;

/**
 * Whether a client may ask for this room.
 *
 * A client names a concern, never a room — the merchant half is taken from its
 * verified token, not from what it sent. Without this, `join` would be an
 * endpoint that lets any signed-in browser subscribe to any string, which is
 * the same leak the prefix was added to close.
 */
export function isSubscribable(concern: string): concern is Concern {
  if (concern === "dashboard" || concern === "approvals") return true;
  return CASE_ROOM.test(concern) || SIM_ROOM.test(concern);
}
