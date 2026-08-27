import type { Metadata } from "next";

import { ApprovalsView } from "@/components/approvals/approvals-view";
import {
  getApprovalHistory,
  getApprovalStats,
  getPendingApprovals,
} from "@/lib/queries";

export const metadata: Metadata = {
  title: "Approvals Queue — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Approvals Queue (PRD 6.3, page 5).
 *
 * The page the track's "compliant escalation" line asks for: the actions Boa
 * planned, checked against the policy pack, and then refused to take on its
 * own. Every card is a real `approvals` row, and the action it stopped is a
 * real `actions` row sitting in `NEEDS_APPROVAL` — which is what makes
 * "nothing was sent" a query rather than a claim (D-64).
 *
 * Three reads, issued together: the queue, the decisions already taken, and
 * the fourteen figures over them. The stats endpoint computes its medians from
 * the rows on every request rather than storing them beside the data (D-72).
 */
export default async function ApprovalsPage() {
  const [pending, history, stats] = await Promise.all([
    getPendingApprovals(),
    getApprovalHistory(),
    getApprovalStats(),
  ]);

  return <ApprovalsView pending={pending} history={history} stats={stats} />;
}
