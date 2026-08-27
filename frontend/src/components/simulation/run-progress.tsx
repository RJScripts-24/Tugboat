"use client";

import type { ReactNode } from "react";

import { ChalkRule, ChalkStroke, ChalkTrack } from "@/components/dashboard/chalk";
import { MoneyValue, Section } from "@/components/dashboard/primitives";
import { ACTOR_TONE, TONE_HEX } from "@/lib/dashboard-data";
import type { RunTotals } from "@/lib/live";
import type { RunStep, SimulationConfig } from "@/lib/simulation-data";
import { ConfigSummary } from "./run-config";

/**
 * State B of the Simulation Lab (PRD 6.3, page 6) - the batch, while it runs.
 *
 * A progress bar on its own is a spinner with a percentage. What makes this
 * worth watching is the three counters beside it: money coming back, cases
 * being handed to a human, and cases being stopped. All three move together,
 * and the last two moving is what tells a room that the bounds are live rather
 * than decorative.
 *
 * The counters come off the frame rather than being interpolated toward a
 * finished report, which is the difference between watching a run and watching
 * an animation of one: these are cases this batch has really closed and
 * contacts it has really sent, at this moment. If the run stalls the numbers
 * stop, instead of sliding smoothly to a total that was decided in advance.
 *
 * This component's job is to draw the frame, not to keep the books.
 */
export function RunProgress({
  config,
  progress,
  totals,
  steps,
  onCancel,
}: {
  config: SimulationConfig;
  /** 0 to 1. */
  progress: number;
  /** The batch's own running totals, as the runner last reported them. */
  totals: RunTotals;
  /** The runner's narration so far, oldest first. */
  steps: RunStep[];
  onCancel: () => void;
}) {
  const done = Math.min(config.batchSize, Math.round(progress * config.batchSize));
  const feed = [...steps].reverse();

  return (
    <div className="space-y-3">
      <Section
        title="Running batch"
        // Leaves the room; it does not kill the batch. A browser closing a
        // socket has no business stopping a run half way through a case.
        action={
          <button type="button" className="btn-op-quiet" onClick={onCancel}>
            Stop watching
          </button>
        }
      >
        <div className="px-5 pb-5 pt-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className="chalk-strong tabular text-[clamp(30px,3vw,42px)] font-semibold leading-none tracking-[-0.02em] text-txt">
              {(progress * 100).toFixed(0)}
              <span className="ml-1 text-[18px] font-normal text-txt-faint">%</span>
            </p>
            <p className="mono text-[12.5px] text-txt-faint">
              {done} of {config.batchSize} cases · {config.arms.length} arms on seed {config.seed}
            </p>
          </div>

          {/* The stroke's own `fraction` carries the progress, exactly as it does
              on the Control Tower's pipeline. An earlier version wrapped a
              full-length stroke in a percentage-width div with a CSS width
              transition on it - and the transition restarted on every animation
              frame, so the bar never got anywhere near the number beside it. The
              requestAnimationFrame loop is already the animation; a second one
              layered over it can only fight it. */}
          <div className="relative mt-3">
            <div className="absolute inset-x-0 top-0">
              <ChalkTrack height={22} />
            </div>
            <ChalkStroke
              fraction={progress}
              color="var(--color-waiting)"
              seed="simulation-run"
              height={22}
              label={`Batch ${Math.round(progress * 100)} percent processed`}
            />
          </div>

          <div className="mt-4">
            <ConfigSummary config={config} />
          </div>
        </div>
      </Section>

      <section
        aria-label="Running totals"
        className="surface grid grid-cols-2 divide-x divide-white/[0.06] xl:grid-cols-4"
      >
        <Counter
          label="Recovered so far"
          value={<MoneyValue paise={totals.recoveredPaise} className="text-recovered" />}
          support={`${totals.recoveredCases} cases closed with the money`}
        />
        <Counter
          label="Contacts sent"
          value={<span className="tabular">{totals.contacts}</span>}
          support="every one of them through the gate first"
        />
        <Counter
          label="Escalated"
          value={<span className="tabular">{totals.escalations}</span>}
          support="handed to a human, agent standing down"
        />
        <Counter
          label="Closed by a rule"
          value={<span className="tabular text-halted">{totals.stopped}</span>}
          support="attempt cap, opt-out or sentiment halt"
        />
      </section>

      <Section title="Runner" meta={`${steps.length} milestone${steps.length === 1 ? "" : "s"}`}>
        <ol className="min-h-[188px] divide-y divide-white/[0.04]">
          {feed.map((step, i) => {
            const hex = TONE_HEX[ACTOR_TONE[step.actor]];
            return (
              <li
                key={step.line}
                className={`flex gap-3.5 px-5 py-2.5${i === 0 ? " feed-enter" : ""}`}
              >
                <span className="mono shrink-0 pt-[1px] text-[11.5px] text-txt-faint">
                  {(step.at * 100).toFixed(0).padStart(3, "0")}%
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
                    {step.actor}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-[1.5] text-txt">
                    {step.line}
                  </span>
                  <span className="mono block truncate text-[11.5px] leading-[1.5] text-txt-faint">
                    {step.meta}
                  </span>
                </span>
              </li>
            );
          })}
          {feed.length === 0 ? (
            <li className="px-5 py-4 text-[12.5px] text-txt-faint">Seeding the batch…</li>
          ) : null}
        </ol>
        <ChalkRule />
        <p className="px-5 py-3 text-[11.5px] leading-[1.55] text-txt-faint">
          The baseline and naive arms run against the same seeded batch as TUGBOAT, in the same
          process, so nothing about the batch can differ between them.
        </p>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Counter({
  label,
  value,
  support,
}: {
  label: string;
  value: ReactNode;
  support: string;
}) {
  return (
    <div className="px-5 py-3.5">
      <p className="chalk-hand text-[13px] uppercase tracking-[0.08em] text-txt-faint">{label}</p>
      <p className="chalk-strong mt-2 text-[clamp(21px,1.7vw,26px)] font-semibold leading-none tracking-[-0.015em] text-txt">
        {value}
      </p>
      <p className="mt-2 text-[11.5px] leading-[1.45] text-txt-dim">{support}</p>
    </div>
  );
}
