import type { Metadata } from "next";

import { AuditExplorer } from "@/components/audit/audit-explorer";
import { getCaseIndex, getLedger, summarise } from "@/lib/audit-data";
import { CLOCK_ANCHOR_MS } from "@/lib/clock";

export const metadata: Metadata = {
  title: "Audit Explorer — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Audit Explorer (PRD 6.3, page 8) - the append-only ledger, browsable.
 *
 * The whole ledger is assembled on the server and sent once. It is built out
 * of the same `getCaseDetail` the Case Detail page renders and the same
 * revisions the Policies page lists, so a digest here and the digest on either
 * of those pages are the same ten characters - which is the only version of
 * this page worth building. A separate audit store that agrees with the
 * product most of the time is worse than no audit page at all.
 */
export default async function AuditPage({
  searchParams,
}: {
  /** `?case=C-1042` - how Case Detail and the Approvals Queue point at their rows. */
  searchParams: Promise<{ case?: string }>;
}) {
  const { case: caseId } = await searchParams;
  const rows = getLedger();

  return (
    <AuditExplorer
      rows={rows}
      summary={summarise(rows)}
      index={getCaseIndex()}
      nowMs={CLOCK_ANCHOR_MS}
      initialCase={caseId ?? null}
    />
  );
}
