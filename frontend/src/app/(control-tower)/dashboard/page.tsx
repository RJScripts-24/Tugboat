import type { Metadata } from "next";
import Link from "next/link";

import { ActivityLog } from "@/components/dashboard/activity-log";
import { CasesTable } from "@/components/dashboard/cases-table";
import { PlayIcon } from "@/components/dashboard/icons";
import { MetricsStrip } from "@/components/dashboard/metrics-strip";
import { PaymentPerformance } from "@/components/dashboard/payment-performance";
import { RecoveryPipeline } from "@/components/dashboard/recovery-pipeline";
import { RootCauseTable } from "@/components/dashboard/root-cause-table";
import {
  getActiveCases,
  getActivityScript,
  getFunnel,
  getKpis,
  getRecoveryByRootCause,
  getSeedActivity,
  getShellStatus,
  getSuccessRateSeries,
} from "@/lib/dashboard-data";

export const metadata: Metadata = {
  title: "Control Tower — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Control Tower (PRD 6.3, page 2).
 *
 * Read top to bottom it answers four questions in order: what are the numbers,
 * where is the money stuck and what is Boa doing about it right now, why is it
 * stuck and is the gateway healthy, and finally - which specific cases would I
 * touch. Metrics, then movement, then diagnosis, then the working list.
 *
 * Data comes from `lib/dashboard-data`, shaped exactly like the `/dashboard/*`
 * endpoints, so this page does not change when the API arrives.
 */
export default function ControlTowerPage() {
  const status = getShellStatus();

  return (
    <div className="space-y-3">
      {/* Run context, then the one action this page offers. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono text-[12px] text-txt-faint">
          seed {status.seed} · 214 seeded cases · {status.playbooks} playbooks active · policy{" "}
          {status.policyVersion}
        </p>

        <Link href="/simulation" className="btn-gold gap-2.5 px-6 py-[11px] text-[14.5px]">
          <PlayIcon className="h-[12px] w-[12px]" />
          Run Simulation
        </Link>
      </div>

      <MetricsStrip kpis={getKpis()} />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1.05fr]">
        <RecoveryPipeline stages={getFunnel()} />
        <ActivityLog seed={getSeedActivity()} script={getActivityScript()} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.1fr_1fr]">
        <RootCauseTable rows={getRecoveryByRootCause()} />
        <PaymentPerformance series={getSuccessRateSeries()} />
      </div>

      <CasesTable rows={getActiveCases()} />
    </div>
  );
}
