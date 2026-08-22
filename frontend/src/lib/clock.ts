/**
 * The batch clock.
 *
 * The seeded run is anchored to one instant and every stamp in the product is
 * measured back from it. A live `Date.now()` would render a different timeline
 * on the server than in the browser - a hydration mismatch on every load - and
 * "14:37" is worth more to a reader than "4 hours ago" on pages whose whole
 * claim is chronology.
 *
 * Extracted from the Case Detail module because the Approvals Queue measures
 * against the same instant: a request that has been waiting 8h 11m on one page
 * and 8h 14m on another is a product nobody trusts twice.
 */

/** 14:40 IST, 22 Aug 2026. */
export const CLOCK_ANCHOR_MS = Date.UTC(2026, 7, 22, 9, 10, 0);

export const CLOCK_ANCHOR_LABEL = "22 Aug 2026 · 14:40 IST";

const IST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const IST_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
});

export type Stamp = { time: string; day: string };

/** Wall-clock IST for an event `minutesAgo` before the anchor. */
export function stampOf(minutesAgo: number): Stamp {
  const at = new Date(CLOCK_ANCHOR_MS - minutesAgo * 60_000);
  return { time: IST_TIME.format(at), day: IST_DAY.format(at) };
}

/** Elapsed time, written the way an operator says it out loud. */
export function formatSpan(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  if (hours < 24) {
    const rest = m % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/** A human response time. Seconds up to a minute, then minutes. */
export function formatLatency(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * A ledger stamp: the same instant, to the millisecond.
 *
 * The Audit Explorer is the one surface where "14:37" is not enough - two rows
 * in the same minute have an order, and an append-only log that cannot show it
 * is an append-only log nobody can reconcile against a gateway's own records.
 */
const IST_PRECISE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

export function preciseStampOf(atMs: number): Stamp {
  const at = new Date(atMs);
  return { time: IST_PRECISE.format(at), day: IST_DAY.format(at) };
}
