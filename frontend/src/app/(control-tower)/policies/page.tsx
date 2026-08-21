import type { Metadata } from "next";

import { ComingNext } from "@/components/shell/coming-next";

export const metadata: Metadata = {
  title: "Policies & Guardrails — Tugboat",
  robots: { index: false, follow: false },
};

export default function PoliciesPage() {
  return (
    <ComingNext
      title="Policies & Guardrails"
      purpose="Proof that the stopping rules are configurable, versioned data — not hardcoded ifs buried in the executor."
      contents={[
        "Contact bounds: max attempts per case, per-channel caps, cool-down between contacts",
        "Quiet hours: 21:00–09:00 IST blocked, TRAI DND-aligned, blocked actions auto-reschedule",
        "Stopping rules, each with its rationale — opt-out halt is locked on and cannot be disabled",
        "Escalation gates: discount threshold, order value, B2B accounts, low diagnosis confidence",
        "Mandate re-presentation caps and spacing, in the spirit of RBI e-mandate discipline",
        "Every save writes a POLICY_CHANGED entry to the audit ledger",
      ]}
    />
  );
}
