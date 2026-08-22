"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChevronRightIcon } from "@/components/dashboard/icons";
import type { ChainTip } from "@/lib/audit-data";
import {
  CLOCK_ANCHOR_LABEL,
  extendAudit,
  type AuditEntry,
  type CaseDetail,
  type EventKind,
} from "@/lib/case-detail-data";
import {
  OVERRIDE_ACTIONS,
  appendEvent,
  caseStateOf,
  useSessionEvents,
  usePolicyVersion,
  type OverrideKind,
} from "@/lib/event-store";
import { CaseFacts } from "./case-facts";
import { CaseLedger } from "./case-ledger";
import { CaseTimeline } from "./case-timeline";

/** What each override writes, and what the ledger row says it did. */
const OVERRIDE_COPY: Record<OverrideKind, { detail: string; outcome: string }> = {
  pause: {
    detail: "Operator paused the agent on this case",
    outcome: "No further action will be planned until a human resumes it",
  },
  resume: {
    detail: "Operator resumed the agent on this case",
    outcome: "Scheduled work may run again, inside the same bounds as before",
  },
  escalate: {
    detail: "Operator took the case off the agent",
    outcome: "Agent stood down · the case is worked by a named human",
  },
  resolve: {
    detail: "Operator marked the case resolved outside Tugboat",
    outcome: "Case closed · no money counted as agent recovery",
  },
};

/** How long the next scheduled node takes to land, in the demo's clock. */
const ARRIVAL_MS = 7_400;

const ACTION_KINDS: EventKind[] = [
  "EMAIL_SENT",
  "WHATSAPP_SENT",
  "VOICE_CALL",
  "RETRY_EXECUTED",
];

const CHANNEL_OF: Partial<Record<EventKind, string>> = {
  EMAIL_SENT: "EMAIL",
  WHATSAPP_SENT: "WHATSAPP",
  VOICE_CALL: "VOICE",
  RETRY_EXECUTED: "RETRY",
};

/**
 * Case Detail (PRD 6.3, page 4) - the money page.
 *
 * Three columns: the facts and the live bounds on the left, the replayable
 * timeline down the middle, the outcome and the ledger on the right. The
 * middle column is the product; the two beside it exist so that every node in
 * it can be read against a limit and checked against a hash.
 *
 * One client component holds all three because they share one clock. When a
 * scheduled action lands, the timeline gains a node, the Bounds panel spends
 * an attempt and a channel, and the ledger gains a row - and if those three
 * were separate islands of state they would drift apart on stage, which is
 * exactly the failure this page is built to argue against.
 */
export function CaseView({
  detail,
  neighbours,
  batchSize,
  tip,
  policyVersion,
}: {
  detail: CaseDetail;
  neighbours: { prev: string | null; next: string | null };
  batchSize: number;
  /** Where this case's chain stood on the server, so appends continue it. */
  tip: ChainTip;
  policyVersion: string;
}) {
  const { record, pending } = detail;

  // The one source of truth for what has happened to this case this session.
  const session = useSessionEvents();
  const state = useMemo(() => caseStateOf(session, record.id), [session, record.id]);
  const policy = usePolicyVersion(policyVersion);

  // A paused or closed case stops receiving scheduled work. A resume lets it
  // continue - which is only possible now that resuming is its own event
  // rather than the absence of a pause.
  const revealed = useArrivals(pending.length, state.paused || state.resolvedExternally);

  // Attempts are spent by the action node, not by planning one.
  const landedActions = pending
    .slice(0, revealed)
    .filter((event) => ACTION_KINDS.includes(event.kind));

  const attemptsUsed = Math.min(record.attemptCap, record.attempts + landedActions.length);
  const extraChannel = landedActions.length > 0 ? CHANNEL_OF[landedActions[0].kind] ?? null : null;

  /** Scheduled work that has landed since the page opened. */
  const arrived = useMemo(
    () => extendAudit(record.id, detail.audit, pending.slice(0, revealed)),
    [record.id, detail.audit, pending, revealed],
  );

  /**
   * Where this case's chain actually ends right now.
   *
   * The server tip is the tail of the *seeded* rows; work that landed while
   * the page was open extends it further. Chaining an override onto the server
   * tip instead would hand it a sequence number the timeline had already used.
   */
  const liveTip: ChainTip = useMemo(() => {
    const last = arrived[arrived.length - 1];
    return last ? { hash: last.hash, seq: last.seq } : tip;
  }, [arrived, tip]);

  const override = useCallback(
    (kind: OverrideKind) => {
      const copy = OVERRIDE_COPY[kind];
      appendEvent({
        chain: record.id,
        caseId: record.id,
        actor: "HUMAN",
        action: OVERRIDE_ACTIONS[kind],
        detail: copy.detail,
        tip: liveTip,
        payload: {
          case_id: record.id,
          override: kind.toUpperCase(),
          by: "Demo Merchant",
          effect: copy.outcome,
          stage_before: record.stage,
        },
      });
    },
    [record.id, record.stage, liveTip],
  );

  /**
   * Rows added since the page opened: work that landed, then every override
   * in the order it was made.
   *
   * The overrides used to be a single row recomputed from one piece of state,
   * so pause → resume → escalate → resolve left one row behind instead of
   * four, and a resume erased the pause it followed. They are now read
   * straight off the log, which cannot lose one.
   */
  const extraAudit = useMemo(() => {
    const appended: AuditEntry[] = session
      .filter((row) => row.chain === record.id)
      .map((row) => ({
        seq: row.seq,
        hash: row.hash,
        prevHash: row.prevHash,
        actor: row.actor,
        action: row.action,
        // Written just now, so they sit at the head of the batch clock.
        minutesAgo: 0,
        detail: row.detail,
      }));
    return [...arrived, ...appended];
  }, [record.id, arrived, session]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono text-[12px] text-txt-faint">
          seed 42 · {record.id} · clock anchored {CLOCK_ANCHOR_LABEL} · contacts masked · policy{" "}
          {policy}
        </p>
        <Walk neighbours={neighbours} id={record.id} batchSize={batchSize} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,290px)_minmax(0,1fr)_minmax(0,320px)]">
        <CaseFacts detail={detail} attemptsUsed={attemptsUsed} extraChannel={extraChannel} />

        <CaseTimeline
          events={detail.events}
          pending={state.paused ? pending.slice(0, revealed) : pending}
          revealed={revealed}
        />

        <CaseLedger
          detail={detail}
          extraAudit={extraAudit}
          state={state}
          onOverride={override}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live arrivals                                                       */
/* ------------------------------------------------------------------ */

/**
 * Scheduled work landing on the timeline.
 *
 * Stands in for the `case.updated` Socket.IO room. It reveals the case's own
 * next steps one at a time and then stops - it never invents an attempt the
 * policy pack would not allow, and a human pause genuinely ends it, because a
 * pause button that the demo animation ignores is worse than no pause button.
 */
function useArrivals(total: number, halted: boolean) {
  const [revealed, setRevealed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (halted || total === 0) return;

    timer.current = setInterval(() => {
      setRevealed((current) => {
        if (current >= total) {
          if (timer.current) clearInterval(timer.current);
          return current;
        }
        return current + 1;
      });
    }, ARRIVAL_MS);

    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [total, halted]);

  return revealed;
}

/* ------------------------------------------------------------------ */

/** Back to the list, and along it - a case is rarely read on its own. */
function Walk({
  neighbours,
  id,
  batchSize,
}: {
  neighbours: { prev: string | null; next: string | null };
  id: string;
  batchSize: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <Link href="/cases" scroll={false} className="filter-control">
        <ChevronRightIcon className="h-[12px] w-[12px] rotate-180" />
        Pipeline
      </Link>

      <span className="mono px-1 text-[11.5px] text-txt-faint">of {batchSize}</span>

      <Step href={neighbours.prev ? `/cases/${neighbours.prev}` : null} label="Newer case">
        <ChevronRightIcon className="h-[12px] w-[12px] rotate-180" />
      </Step>
      <span className="mono px-1 text-[11.5px] text-txt-dim">{id}</span>
      <Step href={neighbours.next ? `/cases/${neighbours.next}` : null} label="Older case">
        <ChevronRightIcon className="h-[12px] w-[12px]" />
      </Step>
    </div>
  );
}

function Step({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
  if (!href) {
    return (
      <span className="filter-control cursor-default opacity-35" aria-disabled>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} aria-label={label} title={label} className="filter-control">
      {children}
    </Link>
  );
}
