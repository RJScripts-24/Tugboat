"use client";

import { ChalkRule } from "@/components/dashboard/chalk";
import { CheckIcon, DraftIcon, LockIcon } from "@/components/dashboard/icons";
import { Section } from "@/components/dashboard/primitives";
import { stampOf } from "@/lib/clock";
import {
  ENFORCEMENT_PATH,
  type PolicyChange,
  type PolicyRevision,
} from "@/lib/policies-data";

/**
 * The policy ledger (PRD 6.3, page 7 - "every save writes a POLICY_CHANGED
 * audit entry").
 *
 * The claim the Policies page is really making is not that these rules are
 * editable. Anything is editable. It is that editing them is a recorded act
 * with a name, a time and a digest against it - which is the difference
 * between a config screen and a control.
 *
 * So the entry is drafted on screen as it is being composed, field by field,
 * before anybody presses Save. A merchant loosening a bound can see the exact
 * row a compliance reviewer will read six months later, while there is still
 * time to change their mind about it.
 */

/* ------------------------------------------------------------------ */
/* The entry a save would write                                        */
/* ------------------------------------------------------------------ */

export function PendingChanges({
  changes,
  version,
  nextVersion,
  by,
  hash,
  prevHash,
}: {
  changes: PolicyChange[];
  version: string;
  nextVersion: string;
  by: string;
  /** The digest this entry would carry, recomputed as the draft changes. */
  hash: string;
  prevHash: string;
}) {
  const looser = changes.filter((change) => change.direction === "looser").length;

  return (
    <Section
      title={changes.length === 0 ? "Nothing to write" : `Pending · ${changes.length} changes`}
      action={
        changes.length === 0 ? (
          <span className="meta">in force: policy {version}</span>
        ) : (
          <span className="mono flex items-center gap-1.5 text-[11.5px] text-waiting">
            <DraftIcon className="h-[12px] w-[12px]" />
            draft {nextVersion}
          </span>
        )
      }
      bodyClassName="px-5 pb-4 pt-3.5"
    >
      {changes.length === 0 ? (
        <p className="max-w-[68ch] text-[12px] leading-[1.65] text-txt-dim">
          The pack on screen is the pack in force. Change anything above and the ledger entry that
          would record it is drafted here — field, old value, new value — before there is anything
          to save.
        </p>
      ) : (
        <>
          <div className="mono flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-txt-faint">
            <span className="uppercase tracking-[0.07em] text-waiting">POLICY_CHANGED</span>
            <span>actor HUMAN · {by}</span>
            <span className="opacity-70">
              {hash} ← {prevHash.slice(0, 6)}
            </span>
          </div>

          <ul className="mt-3 space-y-[7px]">
            {changes.map((change) => (
              <li key={change.path} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="mono min-w-0 text-[11.5px] text-txt-dim">{change.path}</span>
                <span className="mono text-[11.5px] text-txt-faint line-through opacity-70">
                  {change.from}
                </span>
                <span className="text-[11px] text-txt-faint" aria-hidden>
                  →
                </span>
                <span className="mono text-[12px] text-txt">{change.to}</span>
                <Direction direction={change.direction} />
              </li>
            ))}
          </ul>

          <ChalkRule className="mt-3.5" />

          <p className="mt-3 max-w-[70ch] text-[11.5px] leading-[1.6] text-txt-faint">
            {looser === 0
              ? "Nothing here widens a bound. The entry still gets written — a policy history in which only the interesting changes were recorded is not a history."
              : `${looser} of these ${
                  looser === 1 ? "loosens" : "loosen"
                } a bound. That is a merchant's call to make, and the ledger records which way it went so the next person to read this knows a bound was widened rather than having to work it out from the numbers.`}
          </p>
        </>
      )}
    </Section>
  );
}

/** Which way a change went. The only question worth asking about a policy edit. */
function Direction({ direction }: { direction: PolicyChange["direction"] }) {
  if (direction === "changed") return null;
  const looser = direction === "looser";
  return (
    <span
      className={`mono text-[10.5px] uppercase tracking-[0.07em] ${
        looser ? "text-waiting" : "text-diagnosis"
      }`}
    >
      {looser ? "looser" : "tighter"}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Revisions                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every POLICY_CHANGED row on the ledger, newest first.
 *
 * v2 is a loosening that was reverted two days later after three complaints,
 * and it is on the page for the same reason the Evidence Report keeps its
 * exceptions list: a history in which every change was an improvement is a
 * history somebody wrote afterwards.
 */
export function Revisions({
  revisions,
  current,
}: {
  revisions: PolicyRevision[];
  /** The version in force - which is not always the newest row after a save. */
  current: string;
}) {
  return (
    <Section title="Revision history" meta={`${revisions.length} entries · chain verified`}>
      <ol className="px-5 pb-4 pt-1">
        {revisions.map((revision) => {
          const stamp = stampOf(revision.daysAgo * 24 * 60);
          const inForce = revision.version === current;

          return (
            <li
              key={revision.version + revision.hash}
              className="border-b border-white/[0.06] py-3 last:border-b-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="flex items-baseline gap-2.5">
                  <span className="chalk-hand text-[15px] uppercase tracking-[0.06em] text-txt">
                    policy {revision.version}
                  </span>
                  {/* White, not green. Green on this board means money that
                      came back, and "this is the current row" is a state. */}
                  {inForce ? (
                    <span className="mono inline-flex items-center gap-1 text-[10.5px] uppercase tracking-[0.07em] text-txt">
                      <CheckIcon className="h-[9px] w-[9px]" />
                      in force
                    </span>
                  ) : null}
                </span>
                <span className="mono text-[11px] text-txt-faint">
                  {stamp.day} {stamp.time} · {revision.by}
                </span>
              </div>

              <p className="mt-1 text-[12px] leading-[1.55] text-txt-dim">{revision.summary}</p>

              <ul className="mt-1.5 space-y-[3px]">
                {revision.changes.map((line) => (
                  <li key={line} className="mono text-[11px] leading-[1.5] text-txt-faint">
                    {line}
                  </li>
                ))}
              </ul>

              <p className="mono mt-1.5 text-[10.5px] text-txt-faint opacity-70">
                {revision.hash} ← {revision.prevHash.slice(0, 6)}
              </p>
            </li>
          );
        })}
      </ol>

      <ChalkRule />

      <p className="px-5 pb-4 pt-3 text-[11.5px] leading-[1.6] text-txt-faint">
        Each digest covers the entry before it, so a revision cannot be edited out of the history
        without every row after it failing verification. The Audit Explorer verifies this chain
        alongside the case ledger — they are one chain, not two.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Enforcement                                                         */
/* ------------------------------------------------------------------ */

/**
 * How a field on this page becomes a thing that does not happen (PRD 7.1).
 *
 * The page needs this because "configurable" is a weak claim on its own. A
 * settings screen wired to nothing looks exactly like a settings screen wired
 * to everything, and the only difference a reader can check is whether there
 * is a single choke point between the planner and the outside world.
 */
export function Enforcement({ locked }: { locked: number }) {
  return (
    <Section title="How a policy reaches an action" meta="one choke point">
      <ol className="px-5 pb-3 pt-3.5">
        {ENFORCEMENT_PATH.map((step) => (
          <li key={step.step} className="flex gap-3.5 pb-3.5 last:pb-0">
            <span className="mono mt-[2px] shrink-0 text-[11px] text-txt-faint">{step.step}</span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-[13px] leading-[1.5] text-txt">{step.title}</span>
                <span className="mono text-[10.5px] uppercase tracking-[0.07em] text-txt-faint">
                  {step.actor}
                </span>
              </span>
              <span className="mt-1 block max-w-[60ch] text-[11.5px] leading-[1.6] text-txt-dim">
                {step.detail}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <ChalkRule />

      <p className="flex items-start gap-2.5 px-5 pb-4 pt-3 text-[11.5px] leading-[1.6] text-txt-faint">
        <LockIcon className="mt-[2px] h-[12px] w-[12px] shrink-0 text-waiting" />
        <span>
          {locked === 1 ? "One rule on this page cannot" : `${locked} rules on this page cannot`} be
          switched off at any price. Everything else is a merchant&apos;s to set — and every setting
          of it is on the ledger with their name against it.
        </span>
      </p>
    </Section>
  );
}
