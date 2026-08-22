"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { ChevronRightIcon } from "@/components/dashboard/icons";
import {
  CLOCK_ANCHOR_LABEL,
  extendAudit,
  overrideAuditRow,
  type CaseDetail,
  type EventKind,
} from "@/lib/case-detail-data";
import { CaseFacts } from "./case-facts";
import { CaseLedger, type Override } from "./case-ledger";
import { CaseTimeline } from "./case-timeline";

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
}: {
  detail: CaseDetail;
  neighbours: { prev: string | null; next: string | null };
  batchSize: number;
}) {
  const { record, pending } = detail;

  const [override, setOverride] = useState<Override>(null);
  const revealed = useArrivals(pending.length, override !== null);

  // Attempts are spent by the action node, not by planning one.
  const landedActions = pending
    .slice(0, revealed)
    .filter((event) => ACTION_KINDS.includes(event.kind));

  const attemptsUsed = Math.min(record.attemptCap, record.attempts + landedActions.length);
  const extraChannel = landedActions.length > 0 ? CHANNEL_OF[landedActions[0].kind] ?? null : null;

  const extraAudit = useMemo(() => {
    const arrived = extendAudit(record.id, detail.audit, pending.slice(0, revealed));
    if (!override) return arrived;
    return [...arrived, overrideAuditRow(record.id, [...detail.audit, ...arrived], override)];
  }, [record.id, detail.audit, pending, revealed, override]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono text-[12px] text-txt-faint">
          seed 42 · {record.id} · clock anchored {CLOCK_ANCHOR_LABEL} · contacts masked · policy v4
        </p>
        <Walk neighbours={neighbours} id={record.id} batchSize={batchSize} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,290px)_minmax(0,1fr)_minmax(0,320px)]">
        <CaseFacts detail={detail} attemptsUsed={attemptsUsed} extraChannel={extraChannel} />

        <CaseTimeline
          events={detail.events}
          pending={override ? pending.slice(0, revealed) : pending}
          revealed={revealed}
        />

        <CaseLedger
          detail={detail}
          extraAudit={extraAudit}
          override={override}
          onOverride={setOverride}
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
