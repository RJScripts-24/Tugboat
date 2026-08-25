/**
 * IST wall-clock arithmetic for the time-of-day guardrails.
 *
 * India observes no daylight saving, so IST is a fixed UTC+5:30 and every
 * conversion here is exact arithmetic rather than a timezone-database lookup.
 * The server's own timezone never enters into it: a quiet-hours window that
 * moved when the API was deployed to Singapore would be a compliance bug.
 */

export const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;
const DAY_MINUTES = 1440;

/** Payday alignment targets 10:00 IST on the 1st — after salary has landed, not at midnight. */
const PAYDAY_DAY_OF_MONTH = 1;
const PAYDAY_MINUTE = 10 * 60;
/** How far a re-presentation may be pushed to reach a payday. Beyond a week the wait costs more than it wins. */
export const PAYDAY_REACH_DAYS = 7;

export type IstParts = {
  year: number;
  /** 0-indexed, as in Date. */
  month: number;
  day: number;
  /** Minutes past midnight IST. */
  minutes: number;
};

export function istParts(at: Date): IstParts {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** The instant at which the given IST wall-clock time occurs. */
export function fromIst(year: number, month: number, day: number, minutes: number): Date {
  return new Date(Date.UTC(year, month, day, 0, minutes) - IST_OFFSET_MS);
}

export function istMinuteOfDay(at: Date): number {
  return istParts(at).minutes;
}

/** Length of the blocked window, which wraps midnight. Zero means quiet hours are off. */
export function quietSpanMinutes(startMinutes: number, endMinutes: number): number {
  return (((endMinutes - startMinutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

export function isQuiet(minute: number, startMinutes: number, endMinutes: number): boolean {
  const span = quietSpanMinutes(startMinutes, endMinutes);
  if (span === 0) return false;
  return (((minute - startMinutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES < span;
}

/** 1260 -> "21:00". The pack stores minutes; only the edge renders them. */
export function formatClock(minutes: number): string {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * The next instant the quiet window is open, truncated to the minute.
 *
 * A blocked send is deferred to exactly this time rather than dropped, which is
 * what makes quiet hours a scheduling rule instead of a lost contact.
 */
export function nextWindowOpen(at: Date, endMinutes: number): Date {
  const minutes = istMinuteOfDay(at);
  const delta = (((endMinutes - minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const truncated = Math.floor(at.getTime() / 60_000) * 60_000;
  return new Date(truncated + (delta === 0 ? DAY_MINUTES : delta) * 60_000);
}

/** The next 10:00 IST on the 1st of a month, on or after `from`. */
export function nextPayday(from: Date): Date {
  const { year, month, day, minutes } = istParts(from);
  if (day === PAYDAY_DAY_OF_MONTH && minutes <= PAYDAY_MINUTE) {
    return fromIst(year, month, PAYDAY_DAY_OF_MONTH, PAYDAY_MINUTE);
  }
  return fromIst(year, month + 1, PAYDAY_DAY_OF_MONTH, PAYDAY_MINUTE);
}

/**
 * Pushes a re-presentation onto payday when one is close enough to be worth
 * waiting for: re-presenting the morning after a shortfall usually repeats the
 * shortfall, but waiting three weeks for the 1st costs more than it recovers.
 */
export function alignToPayday(candidate: Date): Date {
  const payday = nextPayday(candidate);
  const reachMs = PAYDAY_REACH_DAYS * 24 * 60 * 60_000;
  return payday.getTime() - candidate.getTime() <= reachMs ? payday : candidate;
}
