/**
 * The render clock.
 *
 * Every relative figure in this product — a case open for 4h 11m, a request
 * that has waited since 09:02, a revision cut three days ago — arrives from the
 * API as an offset in minutes rather than as a timestamp. That is deliberate
 * and it predates the API: a component calling `Date.now()` renders one string
 * on the server and a different one in the browser a moment later, which is a
 * hydration mismatch on every load of every page whose whole claim is
 * chronology.
 *
 * So there is one anchor per render, it comes from the server, and every stamp
 * is measured back from it. `<ClockAnchor>` (rendered first inside the Control
 * Tower's layout) sets it from a number the server put in the RSC payload, so
 * the browser measures against the server's instant rather than its own — which
 * is what makes "14:37" the same two characters in both renders.
 *
 * Until Stage 9 this anchor was a constant: the seeded batch was pinned to
 * 22 Aug 2026, 14:40 IST, because a fixture has no other honest "now". Live
 * data does, and this is it.
 */

/**
 * The instant every relative stamp is measured back from.
 *
 * Module-level rather than a React context because it is read from plain
 * functions — `stampOf(minutes)` is called from a dozen components and none of
 * them should have to become a hook to render a time. Written exactly once per
 * render pass, by `<ClockAnchor>`.
 */
let anchorMs = Date.now();

export function setClockAnchor(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) anchorMs = ms;
}

export function clockAnchorMs(): number {
  return anchorMs;
}

const IST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const IST_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
});

const IST_ANCHOR_LABEL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export type Stamp = { time: string; day: string };

/** Wall-clock IST for an event `minutesAgo` before the anchor. */
export function stampOf(minutesAgo: number): Stamp {
  const at = new Date(anchorMs - minutesAgo * 60_000);
  return { time: IST_TIME.format(at), day: IST_DAY.format(at) };
}

/** "26 Aug 2026, 23:41 IST" — what the page's relative times are measured from. */
export function clockAnchorLabel(): string {
  return `${IST_ANCHOR_LABEL.format(new Date(anchorMs)).replace(", ", " · ")} IST`;
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
 * A ledger stamp: an absolute instant, to the millisecond.
 *
 * The Audit Explorer is the one surface where "14:37" is not enough — two rows
 * in the same minute have an order, and an append-only log that cannot show it
 * is one nobody can reconcile against a gateway's own records. Ledger rows
 * carry a real `atMs`, so this needs no anchor.
 */
const IST_PRECISE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

export function preciseStampOf(atMs: number): Stamp {
  const at = new Date(atMs);
  return { time: IST_PRECISE.format(at), day: IST_DAY.format(at) };
}
