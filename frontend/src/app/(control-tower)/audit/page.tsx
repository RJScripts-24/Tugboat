import type { Metadata } from "next";

import { AuditExplorer } from "@/components/audit/audit-explorer";
import { getCaseIndex, getLedgerPage, getLedgerSummary } from "@/lib/queries";

export const metadata: Metadata = {
  title: "Audit Explorer — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Audit Explorer (PRD 6.3, page 8) - the append-only ledger, browsable.
 *
 * A page of the ledger is read on the server and sent once, with the summary
 * counted over all of it. These are the rows the backend wrote inside the
 * transactions that earned them (D-75), so a digest here and the digest beside
 * a case's timeline are the same ten characters — which is the only version of
 * this page worth building. A separate audit store that agrees with the product
 * most of the time is worse than no audit page at all.
 *
 * The verification still runs in the browser, over the rows it was handed. That
 * is the point of shipping the preimage: a server that writes the hashes and
 * then reports them verified has proved nothing.
 */
export default async function AuditPage({
  searchParams,
}: {
  /** `?case=C-1042` - how Case Detail and the Approvals Queue point at their rows. */
  searchParams: Promise<{ case?: string }>;
}) {
  const { case: caseId } = await searchParams;

  const [page, summary, index] = await Promise.all([
    getLedgerPage(),
    // Counted over the whole ledger rather than over the page on screen: a
    // header reading "2,000 entries" because that is how many rows were sent
    // would be an audit surface understating the audit.
    getLedgerSummary(),
    getCaseIndex(),
  ]);

  return (
    <AuditExplorer
      rows={page.rows}
      summary={summary}
      index={index}
      nowMs={Date.now()}
      initialCase={caseId ?? null}
    />
  );
}
