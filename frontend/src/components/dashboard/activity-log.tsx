"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ACTOR_TONE, TONE_HEX, type ActivityEntry } from "@/lib/dashboard-data";
import { Section } from "./primitives";

const MAX_ENTRIES = 40;
const STEP_MS = 3800;

/**
 * Boa's event stream (PRD 6.3, page 2).
 *
 * An operational log, not a notification feed: fixed-width timestamp, actor,
 * what happened, and the technical detail underneath - error codes, confidence
 * values, policy versions, payment ids. That second line is the whole point.
 * A log that only says "message sent" is decoration; one that says which
 * payment link, on which attempt, against which cap, is evidence.
 *
 * Stands in for the `activity.new` Socket.IO room: the effect below steps
 * through the rest of the seeded run so the log breathes during the demo. When
 * the gateway lands it becomes a subscription and nothing else here changes.
 */
export function ActivityLog({
  seed,
  script,
}: {
  seed: ActivityEntry[];
  script: Omit<ActivityEntry, "time">[];
}) {
  const [entries, setEntries] = useState<ActivityEntry[]>(seed);
  const cursor = useRef(0);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (script.length === 0) return;
    setLive(true);

    const id = setInterval(() => {
      const next = script[cursor.current % script.length];
      cursor.current += 1;

      const time = new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date());

      setEntries((current) =>
        [
          // Ids must stay unique across laps of the script, or React reuses rows.
          { ...next, id: `${next.id}-${cursor.current}`, time },
          ...current,
        ].slice(0, MAX_ENTRIES),
      );
    }, STEP_MS);

    return () => clearInterval(id);
  }, [script]);

  return (
    <Section
      title="Boa activity"
      action={
        <span className="flex shrink-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-txt-faint">
          <span
            className={`h-[6px] w-[6px] rounded-full bg-waiting${live ? " pulse-dot" : ""}`}
            aria-hidden
          />
          Live
        </span>
      }
      className="min-h-0"
    >
      {/* Absolutely positioned so the log cannot stretch the row taller than
          the pipeline beside it; the floor keeps it usable when stacked. */}
      <div className="relative min-h-[320px] flex-1">
        <ol
          className="scroll-thin absolute inset-0 divide-y divide-white/[0.04] overflow-y-auto"
          aria-live="polite"
          aria-label="Boa activity log"
        >
          {entries.map((entry, i) => {
            const hex = TONE_HEX[ACTOR_TONE[entry.actor]];
            return (
              <li key={entry.id} className={i === 0 && live ? "feed-enter" : undefined}>
                <Link
                  href={`/cases?case=${encodeURIComponent(entry.caseId)}`}
                  className="flex gap-3.5 px-5 py-2.5 transition-colors hover:bg-white/[0.022]"
                >
                  <span className="mono shrink-0 pt-[1px] text-[11.5px] text-txt-faint">
                    {entry.time}
                  </span>

                  <span className="flex w-[62px] shrink-0 items-center gap-1.5 pt-[1px]">
                    <span
                      className="h-[6px] w-[6px] shrink-0 rounded-[1px]"
                      style={{ backgroundColor: hex }}
                      aria-hidden
                    />
                    <span
                      className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                      style={{ color: hex }}
                    >
                      {entry.actor}
                    </span>
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-[1.5] text-txt">
                      {entry.title}
                    </span>
                    <span className="mono block truncate text-[11.5px] leading-[1.5] text-txt-faint">
                      {entry.meta}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>

        {/* Makes the scroll boundary read as intentional rather than clipped. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-[linear-gradient(to_top,var(--color-console-surface)_15%,transparent)]"
          aria-hidden
        />
      </div>
    </Section>
  );
}
