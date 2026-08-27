"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { useLiveRefresh } from "@/lib/live";
import type { Concern } from "@/lib/socket";

/**
 * Redraws the page from the server when something it is rendering has moved.
 *
 * Renders nothing, and that is the design. The alternative was to make every
 * live surface its own subscriber: the KPI strip patching itself from a
 * `kpi.updated` frame, the funnel recounting from `case.updated`, the stage
 * pills tracking transitions. Each of those would be a second implementation of
 * a query the server already answers — and a second implementation is a second
 * answer, which on a page whose whole argument is that its numbers tie out is
 * the most expensive kind of bug there is.
 *
 * So the socket carries a signal and `router.refresh()` re-runs the server
 * component. What you see after an event is exactly what a reload would show
 * (D-111). The cost is a round trip per burst rather than a patched DOM node,
 * which for a page that refreshes at most once a second is not a cost.
 */
export function LiveRefresh({ concerns }: { concerns?: Concern[] }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);

  useLiveRefresh(refresh, concerns);

  return null;
}
