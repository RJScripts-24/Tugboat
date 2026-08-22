"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { DownloadIcon, PlayIcon, RetryIcon } from "@/components/dashboard/icons";
import {
  buildReportJson,
  type RunStep,
  type SimulationConfig,
} from "@/lib/simulation-data";
import { EvidenceReport, type Report } from "./evidence-report";
import { HonestyCard, ReportContents, RunConfig } from "./run-config";
import { RunHistory } from "./run-history";
import { RunProgress } from "./run-progress";

/** How long the replay takes. Long enough to read, short enough to sit through. */
const RUN_MS = 8_600;

type Phase = "configure" | "running" | "report";

/**
 * The Simulation Lab (PRD 6.3, page 6) - the evidence page.
 *
 * Three states in one component because they are one thing: a configuration,
 * the run it produces, and the report that run leaves behind. Splitting them
 * across routes would let a panelist arrive at a headline number with no
 * statement of what produced it, which is the failure mode this whole page
 * exists to avoid.
 *
 * The run is a replay of an executed batch, not a live one. The real runner
 * streams `simulation.progress` frames over Socket.IO (PRD 7.3) and this
 * component draws them; here the frames are interpolated from a fixed duration
 * against a report that has already been computed. Nothing about the numbers
 * changes when the gateway lands - only where the progress comes from.
 */
export function SimulationLab({
  defaultConfig,
  report,
  script,
}: {
  defaultConfig: SimulationConfig;
  report: Report;
  script: RunStep[];
}) {
  const [config, setConfig] = useState<SimulationConfig>(defaultConfig);
  const [phase, setPhase] = useState<Phase>("configure");
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);

  const tugboat = report.arms.find((arm) => arm.key === "tugboat");
  const contacts = tugboat?.contacts ?? 0;
  const stopped = report.rules
    .filter((rule) => rule.terminal)
    .reduce((sum, rule) => sum + rule.fired, 0);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const run = useCallback(() => {
    stop();

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      setProgress(1);
      setPhase("report");
      return;
    }

    setProgress(0);
    setPhase("running");

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / RUN_MS);
      setProgress(t);
      if (t < 1) {
        frame.current = requestAnimationFrame(tick);
        return;
      }
      frame.current = null;
      setPhase("report");
    };

    frame.current = requestAnimationFrame(tick);
  }, [stop]);

  const cancel = useCallback(() => {
    stop();
    setProgress(0);
    setPhase("configure");
  }, [stop]);

  /**
   * The report as a file (PRD 6.3, page 6 · PRD 12).
   *
   * The whole thing, exceptions included, with the seed and the policy version
   * in the header so it can be checked without running anything. Built in the
   * browser from the same data the page is rendering, so the download and the
   * screen can never disagree.
   */
  const download = useCallback(() => {
    const payload = buildReportJson(config);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tugboat-simulation-seed-${config.seed}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [config]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono text-[12px] text-txt-faint">
          {phase === "running"
            ? `running · seed ${config.seed} · ${config.arms.length} arms · ${config.batchSize} cases`
            : `seed ${config.seed} · ${report.headline.cases} cases · ${report.grading.graded} diagnoses graded · policy v4`}
        </p>

        <div className="flex flex-wrap items-center gap-2.5">
          {phase === "report" ? (
            <button type="button" className="btn-op-quiet" onClick={download}>
              <DownloadIcon className="h-[12px] w-[12px]" />
              Download report · JSON
            </button>
          ) : null}

          {phase === "configure" ? (
            <button type="button" className="btn-op-quiet" onClick={() => setPhase("report")}>
              Open the last report
            </button>
          ) : null}

          {phase === "running" ? null : (
            <button onClick={run} className="btn-gold gap-2.5 px-6 py-[11px] text-[14.5px]">
              {phase === "report" ? (
                <RetryIcon className="h-[13px] w-[13px]" />
              ) : (
                <PlayIcon className="h-[12px] w-[12px]" />
              )}
              {phase === "report" ? "Run again" : "Run batch"}
            </button>
          )}
        </div>
      </div>

      {phase === "configure" ? (
        <>
          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[1.1fr_1fr]">
            <RunConfig config={config} onChange={setConfig} />
            <div className="space-y-3">
              <HonestyCard
                atRiskPaise={report.headline.atRiskPaise}
                cases={report.headline.cases}
                contacts={contacts}
              />
              <ReportContents />
            </div>
          </div>
          <RunHistory runs={report.runs} />
        </>
      ) : null}

      {phase === "running" ? (
        <RunProgress
          config={config}
          progress={progress}
          headline={report.headline}
          escalations={report.escalations.total}
          stopped={stopped}
          contacts={contacts}
          script={script}
          onCancel={cancel}
        />
      ) : null}

      {phase === "report" ? (
        <EvidenceReport config={config} report={report} executed={defaultConfig} />
      ) : null}
    </div>
  );
}
