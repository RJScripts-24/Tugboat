import type { Metadata } from "next";

import { PoliciesView } from "@/components/policies/policies-view";
import { DEMO_MERCHANT } from "@/lib/demo-merchant";
import {
  getLatestReport,
  getLedgerSize,
  getPendingApprovals,
  getPolicies,
} from "@/lib/queries";

export const metadata: Metadata = {
  title: "Policies & Guardrails — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Policies & Guardrails (PRD 6.3, page 7) — proof that the stopping rules are
 * configurable system objects rather than hardcoded ifs.
 *
 * Assembled from four endpoints, which is the whole argument in one import
 * list: the pack in force with the revisions behind it, how often each of its
 * rules actually fired on the batch (the same counts the Evidence Report
 * publishes), what is waiting on a human right now because of one of its gates
 * (the same requests the Approvals Queue renders), and the size of the ledger
 * that recorded all of it.
 *
 * None of those numbers are restated here. A policy page quoting its own
 * figures for how well its policies work is a page nobody should believe.
 */
export default async function PoliciesPage() {
  const [policies, report, pending, ledgerEntries] = await Promise.all([
    getPolicies(),
    // Null until a batch has been run and completed. The page renders every
    // rule regardless — a guardrail list showing only the rules that have
    // fired is a guardrail list you cannot audit.
    getLatestReport(),
    getPendingApprovals(),
    getLedgerSize(),
  ]);

  // Keyed by the rule ids the Evidence Report counts against, so a firing
  // figure on this page and the same figure in the report are one number.
  const firings = Object.fromEntries(
    (report?.report.stoppingRules ?? []).map((rule) => [rule.key, rule.fired]),
  ) as Record<string, number>;

  // Counted from the queue itself rather than carried beside it — the same
  // rule the shell badge follows.
  const queue: Record<string, number> = {};
  for (const request of pending) {
    queue[request.gate] = (queue[request.gate] ?? 0) + 1;
  }

  return (
    <PoliciesView
      pack={policies.pack}
      version={policies.version}
      revisions={policies.revisions}
      firings={firings}
      queue={queue}
      // The live ledger's own size, counted from it. The figure used to come
      // from the simulation's compliance block, which describes a different
      // ledger entirely — hence this page claiming 4,318 while the Audit
      // Explorer showed 1,885.
      ledgerEntries={ledgerEntries}
      // The compliance block of the promoted run, so "Violations" is counted
      // from assertions that were actually evaluated against ledger rows. It
      // used to be the literal 0, captioned "recomputed from N ledger entries"
      // over a denominator that had nothing to do with any check.
      compliance={report?.report.compliance ?? null}
      seed={report?.run.seed ?? null}
      merchantName={DEMO_MERCHANT.displayName}
    />
  );
}
