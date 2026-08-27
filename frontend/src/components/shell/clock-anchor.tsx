"use client";

import { setClockAnchor } from "@/lib/clock";

/**
 * Hands the browser the server's instant.
 *
 * Renders nothing. Its whole job is to carry one number across the boundary:
 * the layout is a server component, it knows what time it was when the page was
 * built, and every relative stamp on every page has to be measured back from
 * *that* instant rather than from whenever the browser got around to
 * hydrating — otherwise "opened 4h 11m ago" is 4h 11m on the server and 4h 12m
 * in the browser, and React logs a hydration mismatch on the busiest surface in
 * the demo.
 *
 * Setting a module variable during render is impure, and here it is the
 * cheapest correct thing: it happens before any sibling renders (React renders
 * children in order), it is idempotent, and the value comes from the RSC
 * payload rather than from the client's own clock — so both passes compute the
 * same string from the same number. The alternative is threading a `nowMs` prop
 * through a dozen components that only want to print a time (D-115).
 */
export function ClockAnchor({ ms }: { ms: number }) {
  setClockAnchor(ms);
  return null;
}
