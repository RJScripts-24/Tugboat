import type { Metadata } from "next";

import { SimulationLab } from "@/components/simulation/simulation-lab";
import { getDefaultConfig, getLatestReport, getRunHistory } from "@/lib/queries";

export const metadata: Metadata = {
  title: "Simulation Lab — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Simulation Lab (PRD 6.3, page 6) — the evidence page.
 *
 * The report is read whole from `GET /simulations/:id/report` and handed down:
 * one object, the same one `docs/evidence/` ships as a file, so the screen and
 * the download cannot disagree. Which run it is matters — the promoted one,
 * because that is the batch the rest of the Control Tower is narrating, and an
 * evidence page describing a different 214 cases than the dashboard would be
 * the most expensive kind of demo bug.
 *
 * The run itself is no longer a replay. `POST /simulations` starts a real
 * batch, the runner narrates itself over the `sim:<runId>` socket room, and the
 * counters beside the bar are cases this batch has actually closed. That is
 * also why it takes minutes rather than the eight and a half seconds the
 * seeded animation took: it is doing the work.
 */
export default async function SimulationPage() {
  const [latest, runs] = await Promise.all([getLatestReport(), getRunHistory()]);

  return (
    <SimulationLab
      defaultConfig={getDefaultConfig(latest?.run, latest?.report)}
      report={latest?.report ?? null}
      runs={runs}
    />
  );
}
