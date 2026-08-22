import type { Metadata } from "next";

import { PoliciesView } from "@/components/policies/policies-view";
import { getPendingApprovals } from "@/lib/approvals-data";
import { getChainTip, getLedgerSize } from "@/lib/audit-data";
import { DEMO_MERCHANT } from "@/lib/demo-merchant";
import { getPolicyPack, getRevisions, POLICY_VERSION } from "@/lib/policies-data";
import { getRuleFirings } from "@/lib/simulation-data";

export const metadata: Metadata = {
  title: "Policies & Guardrails — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Policies & Guardrails (PRD 6.3, page 7) - proof that the stopping rules are
 * configurable system objects rather than hardcoded ifs.
 *
 * Assembled on the server from three modules that already exist, which is the
 * whole argument in one import list: the pack itself, how often each of its
 * rules actually fired on the seeded batch (`lib/simulation-data`, the same
 * counts the Evidence Report publishes), and what is waiting on a human right
 * now because of one of its gates (`lib/approvals-data`, the same requests the
 * Approvals Queue renders).
 *
 * None of those numbers are restated here. A policy page quoting its own
 * figures for how well its policies work is a page nobody should believe.
 */
export default function PoliciesPage() {
  // Keyed by the rule ids the Evidence Report counts against, so a firing
  // figure on this page and the same figure in the report are one number.
  const firings = Object.fromEntries(
    getRuleFirings().map((rule) => [rule.key, rule.fired]),
  ) as Record<string, number>;

  // Counted from the queue itself rather than carried beside it - the same
  // rule the shell badge follows.
  const queue: Record<string, number> = {};
  for (const request of getPendingApprovals()) {
    queue[request.gate] = (queue[request.gate] ?? 0) + 1;
  }

  return (
    <PoliciesView
      pack={getPolicyPack()}
      version={POLICY_VERSION}
      revisions={getRevisions()}
      firings={firings}
      queue={queue}
      // The live ledger's own size, counted from it. The figure used to come
      // from the simulation's compliance block, which describes a different
      // ledger entirely - hence this page claiming 4,318 while the Audit
      // Explorer showed 1,885.
      ledgerEntries={getLedgerSize()}
      merchantName={DEMO_MERCHANT.displayName}
      tip={getChainTip("policy")}
    />
  );
}
