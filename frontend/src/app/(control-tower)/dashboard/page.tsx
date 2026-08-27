import type { Metadata } from "next";
import Link from "next/link";

import { ActivityLog } from "@/components/dashboard/activity-log";
import { CasesTable } from "@/components/dashboard/cases-table";
import { PlayIcon } from "@/components/dashboard/icons";
import { LiveRefresh } from "@/components/dashboard/live-refresh";
import { MetricsStrip } from "@/components/dashboard/metrics-strip";
import { PaymentPerformance } from "@/components/dashboard/payment-performance";
import { RecoveryPipeline } from "@/components/dashboard/recovery-pipeline";
import { RootCauseTable } from "@/components/dashboard/root-cause-table";
import {
  getActiveCases,
  getFunnel,
  getKpis,
  getRecoveryByRootCause,
  getSeedActivity,
  getShellStatus,
  getSuccessRateSeries,
} from "@/lib/queries";

export const metadata: Metadata = {
  title: "Control Tower — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Control Tower (PRD 6.3, page 2).
 *
 * Read top to bottom it answers four questions in order: what are the numbers,
 * where is the money stuck and what is Boa doing about it right now, why is it
 * stuck and is the gateway healthy, and finally — which specific cases would I
 * touch. Metrics, then movement, then diagnosis, then the working list.
 *
 * Seven reads, issued together. They are independent queries against one
 * database and awaiting them in sequence would make the slowest page in the
 * product the sum of its parts rather than the worst of them.
 *
 * Nothing on this page holds its own copy of anything. When a case moves,
 * `<LiveRefresh>` re-runs *this function* rather than patching six components
 * from a socket frame — so what is on screen after an event is what a reload
 * would show (D-111).
 */
export default async function ControlTowerPage() {
  const [status, kpis, funnel, activity, causes, series, cases] = await Promise.all([
    getShellStatus(),
    getKpis(),
    getFunnel(),
    getSeedActivity(),
    getRecoveryByRootCause(),
    getSuccessRateSeries(),
    getActiveCases(),
  ]);

  return (
    <div className="space-y-3">
      <LiveRefresh />

      {/*
        Run context, then the one action this page offers.

        The banner is not decoration. These figures move while you watch — the
        activity feed lands new lines, cases change stage, the recovered counter
        ticks — and the Simulation Lab's do not, because that is a fixed run of
        a fixed seed. A judge who sees one number here and the same number there
        on Monday and different ones on Tuesday needs to know which of the two
        was supposed to move.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-txt-faint">
          <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-[rgba(255,232,134,0.32)] px-2 py-[2px] text-waiting">
            <span className="pulse-dot h-[5px] w-[5px] rounded-full bg-waiting" aria-hidden />
            LIVE
          </span>
          <span>
            {status.seed > 0 ? `seed ${status.seed} · ` : ""}
            {kpis.revenueAtRiskCases} cases · {status.playbooks} playbooks active · policy{" "}
            {status.policyVersion} · figures move as work lands
          </span>
        </p>

        <Link href="/simulation" className="btn-gold gap-2.5 px-6 py-[11px] text-[14.5px]">
          <PlayIcon className="h-[12px] w-[12px]" />
          Run Simulation
        </Link>
      </div>

      <MetricsStrip kpis={kpis} />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1.05fr]">
        <RecoveryPipeline stages={funnel} />
        <ActivityLog seed={activity} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.1fr_1fr]">
        <RootCauseTable rows={causes} />
        <PaymentPerformance series={series} />
      </div>

      <CasesTable rows={cases} />
    </div>
  );
}
