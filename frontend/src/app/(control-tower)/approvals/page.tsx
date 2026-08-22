import type { Metadata } from "next";

import { ApprovalsView } from "@/components/approvals/approvals-view";
import { getLedgerTips } from "@/lib/audit-data";
import {
  getApprovalHistory,
  getApprovalStats,
  getLiveEscalation,
  getPendingApprovals,
} from "@/lib/approvals-data";

export const metadata: Metadata = {
  title: "Approvals Queue — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Approvals Queue (PRD 6.3, page 5).
 *
 * The page the track's "compliant escalation" line asks for: the actions Boa
 * planned, checked against policy v4, and then refused to take on its own.
 *
 * All four datasets are read on the server from `lib/approvals-data`, shaped
 * exactly like `GET /approvals` and `GET /approvals/stats`, so this page does
 * not change when the API arrives.
 */
export default function ApprovalsPage() {
  return (
    <ApprovalsView
      pending={getPendingApprovals()}
      history={getApprovalHistory()}
      live={getLiveEscalation()}
      stats={getApprovalStats()}
      // A decision is a ledger row on the case's own chain, so the view needs
      // to know where each of those chains ends.
      tips={getLedgerTips()}
    />
  );
}
