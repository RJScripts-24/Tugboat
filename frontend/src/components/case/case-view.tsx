"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";

import { ChevronRightIcon } from "@/components/dashboard/icons";
import { overrideCase } from "@/lib/actions";
import { clockAnchorLabel } from "@/lib/clock";
import type { CaseDetailWithNeighbours } from "@/lib/case-detail-data";
import { caseStateOf, OVERRIDE_ROUTES, type OverrideKind } from "@/lib/event-store";
import { useLiveRefresh } from "@/lib/live";
import { CaseFacts } from "./case-facts";
import { CaseLedger } from "./case-ledger";
import { CaseTimeline } from "./case-timeline";

/**
 * Case Detail (PRD 6.3, page 4) — the money page.
 *
 * Three columns: the facts and the live bounds on the left, the replayable
 * timeline down the middle, the outcome and the ledger on the right. The middle
 * column is the product; the two beside it exist so that every node in it can
 * be read against a limit and checked against a hash.
 *
 * They no longer share a clock, and that is the Stage 9 change worth reading.
 * This component used to run the case: an interval revealed the next scheduled
 * node, the bounds panel spent an attempt when it landed, and an override wrote
 * its own ledger row in the browser so all three could agree with each other.
 * They agree now because there is nothing to agree — the events came from the
 * Executor, the bounds from the gate, the ledger rows from the transactions
 * that wrote them, and this component draws what it was handed.
 *
 * What replaced the interval is `useLiveRefresh` on this case's own socket room:
 * when the Executor really does send the next nudge, the page re-renders from
 * the server and the node appears because it happened.
 */
export function CaseView({
  detail,
  neighbours,
  policyVersion,
}: {
  detail: CaseDetailWithNeighbours;
  neighbours: { prev: string | null; next: string | null };
  policyVersion: string;
}) {
  const { record } = detail;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // This case's own room, plus the dashboard's: an override changes both the
  // case and the merchant's KPIs, and a nudge landing changes the timeline.
  useLiveRefresh(
    useCallback(() => router.refresh(), [router]),
    useMemo(() => [`case:${record.id}` as const, "dashboard" as const], [record.id]),
  );

  /**
   * Paused, taken over, closed elsewhere — folded from the case's own chain.
   *
   * Not from a `pausedAt` boolean, even though the column exists and the
   * response carries it. The fold is what makes a resume a row that follows a
   * pause rather than one that erases it, and the audit panel below shows both.
   */
  const state = useMemo(() => caseStateOf(detail.audit), [detail.audit]);

  const override = useCallback(
    (kind: OverrideKind) => {
      setError(null);
      startTransition(async () => {
        const result = await overrideCase(record.id, OVERRIDE_ROUTES[kind]);
        // The server wrote the ledger row; `revalidatePath` in the action
        // re-renders this page from it. Nothing is patched in here, so there is
        // no version of this case that exists only in the browser.
        if (!result.ok) setError(result.error);
      });
    },
    [record.id],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono text-[12px] text-txt-faint">
          {record.id} · times measured from {clockAnchorLabel()} · contacts masked · policy{" "}
          {policyVersion}
        </p>
        <Walk neighbours={neighbours} id={record.id} batchSize={detail.batchSize} />
      </div>

      {error ? (
        <p className="mono rounded-[2px] border border-[rgba(229,72,77,0.35)] px-3 py-2 text-[11.5px] text-halted">
          {error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,290px)_minmax(0,1fr)_minmax(0,320px)]">
        <CaseFacts detail={detail} attemptsUsed={record.attempts} extraChannel={null} />

        <CaseTimeline events={detail.events} pending={detail.pending} revealed={0} />

        <CaseLedger detail={detail} state={state} onOverride={override} busy={pending} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Back to the list, and along it — a case is rarely read on its own. */
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
