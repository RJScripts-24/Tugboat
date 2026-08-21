import type { Metadata } from "next";

import { ComingNext } from "@/components/shell/coming-next";

export const metadata: Metadata = {
  title: "Approvals Queue — Tugboat",
  robots: { index: false, follow: false },
};

export default function ApprovalsPage() {
  return (
    <ComingNext
      title="Approvals Queue"
      purpose="Compliant escalation, made visible. Actions Boa is not allowed to take alone wait here for a human."
      contents={[
        "One card per request: the case, the money, and the agent's justification",
        "Policy context chips showing which cap the action would have crossed",
        "The exact draft that would be sent, expandable and editable before approval",
        "Approve & Execute resumes the case live; Reject requires a reason",
        "History tab with approval latency — the human is part of the measured loop",
      ]}
    />
  );
}
