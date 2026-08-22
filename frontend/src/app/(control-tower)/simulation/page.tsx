import type { Metadata } from "next";

import { SimulationLab } from "@/components/simulation/simulation-lab";
import {
  getArmResults,
  getCompliance,
  getDefaultConfig,
  getEscalationSummary,
  getExceptions,
  getGrading,
  getHeadline,
  getRecoveryByType,
  getRuleFirings,
  getRunHistory,
  getRunScript,
} from "@/lib/simulation-data";

export const metadata: Metadata = {
  title: "Simulation Lab — Tugboat",
  robots: { index: false, follow: false },
};

/**
 * Simulation Lab (PRD 6.3, page 6) - the evidence page.
 *
 * The whole report is assembled on the server from `lib/simulation-data`,
 * shaped exactly like `GET /simulations/:id/report` (PRD 7.5), so this page
 * does not change when the batch runner arrives. Nothing is fetched in the
 * browser and nothing is computed twice: the client component replays a run
 * whose numbers were already settled here.
 */
export default function SimulationPage() {
  return (
    <SimulationLab
      defaultConfig={getDefaultConfig()}
      script={getRunScript()}
      report={{
        headline: getHeadline(),
        arms: getArmResults(),
        byType: getRecoveryByType(),
        grading: getGrading(),
        rules: getRuleFirings(),
        compliance: getCompliance(),
        escalations: getEscalationSummary(),
        exceptions: getExceptions(),
        runs: getRunHistory(),
      }}
    />
  );
}
