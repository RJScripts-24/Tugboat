import type { Metadata } from "next";

import { ComingNext } from "@/components/shell/coming-next";

export const metadata: Metadata = {
  title: "Audit Explorer — Tugboat",
  robots: { index: false, follow: false },
};

export default function AuditPage() {
  return (
    <ComingNext
      title="Audit Explorer"
      purpose="The append-only ledger, browsable. Read-only by design — no edit or delete affordance exists on this page."
      contents={[
        "Every entry: timestamp, hash prefix, previous-hash link, actor, action, case",
        "Expandable JSON payload with PII fields visibly masked",
        "Filter by actor: Agent, Policy Gate, Human, System",
        "Verify chain — recompute the hash chain and prove the log is tamper-evident",
      ]}
    />
  );
}
