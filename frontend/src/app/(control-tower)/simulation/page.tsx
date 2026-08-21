import type { Metadata } from "next";

import { ComingNext } from "@/components/shell/coming-next";

export const metadata: Metadata = {
  title: "Simulation Lab — Tugboat",
  robots: { index: false, follow: false },
};

export default function SimulationPage() {
  return (
    <ComingNext
      title="Simulation Lab"
      purpose="The evidence page. A seeded batch of 200+ synthetic cases, run against three policy arms, reported honestly."
      contents={[
        "Configure: batch size, case-type mix, difficulty preset, random seed, policy pack",
        "Headline: rupees recovered versus a no-agent baseline, and the uplift between them",
        "Diagnosis accuracy against ground truth, stopping-rule trigger counts, cost per ₹100 recovered",
        "Baseline vs naive vs Tugboat — naive sends 3× the messages and recovers less",
        "The exceptions list: what the agent could not recover, and why",
      ]}
    />
  );
}
