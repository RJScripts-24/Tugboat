"use client";

import Link from "next/link";


import { ACTOR_TONE, TONE_HEX, type ActivityEntry } from "@/lib/dashboard-data";
import { useActivityFeed } from "@/lib/live";
import { Section } from "./primitives";

/**
 * Boa's event stream (PRD 6.3, page 2).
 *
 * An operational log, not a notification feed: fixed-width timestamp, actor,
 * what happened, and the technical detail underneath — error codes, confidence
 * values, policy versions, payment ids. That second line is the whole point. A
 * log that only says "message sent" is decoration; one that says which payment
 * link, on which attempt, against which cap, is evidence.
 *
 * The lines are real now. `seed` is the last forty case events the server read
 * back through the same mapper the socket uses, and `activity.new` continues
 * it — so a line that was already there and a line that just arrived are
 * indistinguishable, which is what makes the feed worth watching rather than
 * worth timing.
 *
 * The "Live" dot follows the transport rather than a timer. A disconnected
 * socket shows a still dot beside a log that has stopped moving, which is the
 * truth; the previous version pulsed regardless, because there was nothing
 * underneath it that could be disconnected.
 */
export function ActivityLog({ seed }: { seed: ActivityEntry[] }) {
  const { entries, live } = useActivityFeed(seed);

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
                {/* An entry names one case, so it opens that case. This is the
                    demo's own path: a line lands in the feed, you click it, and
                    the full story of it is on screen. An entry that belongs to
                    no single case carries its own destination instead - a
                    degradation opens the cases it opened. */}
                <Link
                  href={entry.href ?? `/cases/${encodeURIComponent(entry.caseId)}`}
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
