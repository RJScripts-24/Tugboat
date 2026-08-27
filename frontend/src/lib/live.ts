"use client";

import { useEffect, useRef, useState } from "react";

import type { ActivityEntry } from "@/lib/dashboard-data";
import type { RunStep } from "@/lib/simulation-data";
import { onConnectionChange, subscribe, type Concern } from "@/lib/socket";

/**
 * The Control Tower's live surfaces, as hooks.
 *
 * Each one has the same shape and the same promise: it is handed what the
 * server already rendered, and it only ever moves that forward. Nothing here
 * fetches on mount, nothing here is the first source of anything on screen, and
 * a socket that never connects leaves every one of them showing the server's
 * answer — which is the correct answer, just not a moving one.
 */

/* ------------------------------------------------------------------ */
/* activity.new                                                        */
/* ------------------------------------------------------------------ */

/** How many lines the log keeps. Older ones are off-screen and unread. */
const MAX_ENTRIES = 60;

export function useActivityFeed(seed: ActivityEntry[]): {
  entries: ActivityEntry[];
  live: boolean;
} {
  const [entries, setEntries] = useState(seed);
  const [live, setLive] = useState(false);

  // The server's page is authoritative on every render it does: a navigation
  // back to the dashboard should show what the server just read, not a list
  // this component has been carrying since the tab was opened.
  useEffect(() => setEntries(seed), [seed]);

  useEffect(() => onConnectionChange(setLive), []);

  useEffect(
    () =>
      subscribe<ActivityEntry>("dashboard", "activity.new", (entry) => {
        setEntries((current) => {
          // Ids are the event row's own, so a reconnect that replays the tail
          // cannot produce two lines for one event.
          if (current.some((row) => row.id === entry.id)) return current;
          return [entry, ...current].slice(0, MAX_ENTRIES);
        });
      }),
    [],
  );

  return { entries, live };
}

/* ------------------------------------------------------------------ */
/* case.updated · kpi.updated · policy.changed                         */
/* ------------------------------------------------------------------ */

export type CaseUpdate = {
  caseId: string;
  stage: string;
  kind: string;
  recoveredPaise: number;
  attempts: number;
};

/**
 * Tells a page that what it is rendering has moved on.
 *
 * Deliberately does not carry the new data. The stage pills, the funnel, the
 * KPI strip and the case table are server components computed from six
 * different queries, and patching each of them from a socket frame would mean
 * writing a second implementation of every one of those queries in the browser
 * — a second implementation that would then disagree with the first. So the
 * frame is a signal, and the page re-renders on the server (D-111).
 *
 * Coalesced, because a burst of recoveries publishes a frame each and a refresh
 * per frame would be a refresh loop.
 */
export function useLiveRefresh(onChange: () => void, concerns: Concern[] = ["dashboard"]): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    const nudge = (): void => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        latest.current();
      }, REFRESH_COALESCE_MS);
    };

    const offs = concerns.flatMap((concern) => [
      subscribe(concern, "case.updated", nudge),
      subscribe(concern, "kpi.updated", nudge),
      subscribe(concern, "approval.decided", nudge),
      subscribe(concern, "policy.changed", nudge),
    ]);

    return () => {
      for (const off of offs) off();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    // The concern list is fixed per call site; joining on its identity would
    // resubscribe on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [concerns.join("|")]);
}

/** Long enough to swallow a burst, short enough that a demo still feels live. */
const REFRESH_COALESCE_MS = 900;

/* ------------------------------------------------------------------ */
/* approval.pending · approval.decided                                 */
/* ------------------------------------------------------------------ */

/**
 * The sidebar badge.
 *
 * Takes the count whole from every frame rather than incrementing on one event
 * and decrementing on another. A counter driven by deltas is a counter that is
 * permanently wrong the first time a frame is missed — and a socket that
 * reconnected mid-decision misses one (D-106).
 */
export function usePendingApprovals(initial: number): number {
  const [pending, setPending] = useState(initial);

  useEffect(() => setPending(initial), [initial]);

  useEffect(() => {
    const read = (payload: { pending?: number }): void => {
      if (typeof payload?.pending === "number") setPending(payload.pending);
    };

    const offs = [
      subscribe<{ pending?: number }>("approvals", "approval.pending", read),
      subscribe<{ pending?: number }>("approvals", "approval.decided", read),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, []);

  return pending;
}

/* ------------------------------------------------------------------ */
/* sim.progress · sim.completed                                        */
/* ------------------------------------------------------------------ */

export type RunTotals = {
  recoveredPaise: number;
  recoveredCases: number;
  contacts: number;
  escalations: number;
  stopped: number;
};

export type RunFrame = {
  progress: number;
  steps: RunStep[];
  totals: RunTotals;
  status: "running" | "completed" | "failed";
  failureReason: string | null;
};

const EMPTY_TOTALS: RunTotals = {
  recoveredPaise: 0,
  recoveredCases: 0,
  contacts: 0,
  escalations: 0,
  stopped: 0,
};

/**
 * A batch, while it runs.
 *
 * The counters come off the frame rather than being interpolated against a
 * finished report the way the seeded replay did. That is the difference between
 * watching a run and watching an animation of one: these are cases this batch
 * has really closed, at this moment, and if the run stalls the numbers stop
 * rather than sliding smoothly to a total that was decided in advance.
 */
export function useSimRun(runId: string | null): RunFrame {
  const [frame, setFrame] = useState<RunFrame>(INITIAL_FRAME);

  useEffect(() => {
    if (!runId) {
      setFrame(INITIAL_FRAME);
      return;
    }

    setFrame(INITIAL_FRAME);
    const concern: Concern = `sim:${runId}`;

    const offs = [
      subscribe<{ progress: number; step: RunStep | null; totals: RunTotals }>(
        concern,
        "sim.progress",
        (payload) =>
          setFrame((current) => ({
            ...current,
            progress: Math.max(current.progress, payload.progress),
            steps: payload.step ? [...current.steps, payload.step] : current.steps,
            totals: payload.totals ?? current.totals,
            status: "running",
          })),
      ),
      subscribe<{ status: string; failureReason: string | null }>(
        concern,
        "sim.completed",
        (payload) =>
          setFrame((current) => ({
            ...current,
            progress: payload.status === "COMPLETED" ? 1 : current.progress,
            status: payload.status === "COMPLETED" ? "completed" : "failed",
            failureReason: payload.failureReason ?? null,
          })),
      ),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, [runId]);

  return frame;
}

const INITIAL_FRAME: RunFrame = {
  progress: 0,
  steps: [],
  totals: EMPTY_TOTALS,
  status: "running",
  failureReason: null,
};
