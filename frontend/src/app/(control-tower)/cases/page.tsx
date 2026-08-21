import type { Metadata } from "next";

import { ComingNext } from "@/components/shell/coming-next";

export const metadata: Metadata = {
  title: "Recovery Pipeline — Tugboat",
  robots: { index: false, follow: false },
};

export default function PipelinePage() {
  return (
    <ComingNext
      title="Recovery Pipeline"
      purpose="Every at-risk rupee as a workable list — the operational view behind the funnel."
      contents={[
        "Filter bar: case type, status, root cause, amount range, customer search",
        "Dense table: case ID, type, masked customer, amount, root cause tag, stage pill, next action, attempts against cap",
        "Stage pills that update in place over the socket, with a brief highlight flash",
        "Row click opens Case Detail — the full replayable story of one case",
      ]}
    />
  );
}
