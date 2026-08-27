import type { Metadata } from "next";
import { Suspense } from "react";

import { LiveRefresh } from "@/components/dashboard/live-refresh";
import { PipelineView } from "@/components/pipeline/pipeline-view";
import { getPipelineCases } from "@/lib/queries";

export const metadata: Metadata = {
  title: "Recovery Pipeline — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Recovery Pipeline (PRD 6.3, page 3).
 *
 * The batch is read from `GET /cases` on the server and handed down whole; the
 * view is a client component because filtering, sorting and paging all live in
 * the URL and have to feel instant, and a round trip per checkbox is not
 * instant. The stage pills move because `<LiveRefresh>` re-runs this function
 * when a case transitions — the props do not change shape for it.
 */
export default async function PipelinePage() {
  const cases = await getPipelineCases();

  return (
    // useSearchParams needs a boundary to suspend at during prerender.
    <Suspense fallback={<PipelineSkeleton />}>
      <LiveRefresh />
      <PipelineView cases={cases} />
    </Suspense>
  );
}

/** Skeletons, never a spinner on a full page (PRD 6.4). */
function PipelineSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="h-[18px] w-[380px] max-w-full animate-pulse rounded-[2px] bg-white/[0.05]" />
      <div className="grid grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="px-5 py-3.5">
            <div className="h-[12px] w-[92px] animate-pulse rounded-[2px] bg-white/[0.05]" />
            <div className="mt-3 h-[24px] w-[118px] animate-pulse rounded-[2px] bg-white/[0.05]" />
          </div>
        ))}
      </div>
      <div className="surface h-[560px] animate-pulse bg-white/[0.02]" />
    </div>
  );
}
