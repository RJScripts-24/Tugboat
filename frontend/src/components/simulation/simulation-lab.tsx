"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CheckIcon, DownloadIcon, PlayIcon, RetryIcon } from "@/components/dashboard/icons";
import type { ChainTip } from "@/lib/audit-data";
import { appendEvent } from "@/lib/event-store";
import {
  buildReportJson,
  type RunStep,
  type SavedRun,
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
  tip,
}: {
  defaultConfig: SimulationConfig;
  report: Report;
  script: RunStep[];
  /** Where the `policy` chain ends, so a saved run can be recorded on it. */
  tip: ChainTip;
}) {
  const [config, setConfig] = useState<SimulationConfig>(defaultConfig);
  const [phase, setPhase] = useState<Phase>("configure");
  const [progress, setProgress] = useState(0);
  const [saved, setSaved] = useState<SavedRun[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const frame = useRef<number | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((message: string) => {
    setNote(message);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 5_000);
  }, []);

  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );

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
    flash(`tugboat-simulation-seed-${config.seed}.json downloaded`);
  }, [config, flash]);

  /**
   * The report as a PDF (PRD 6.3, page 6 · PRD 12).
   *
   * Through the browser's own print pipeline rather than a bundled PDF
   * library: the report is already a laid-out document, a print stylesheet
   * turns it into a page-broken one, and "Save as PDF" produces a file that
   * matches what a judge saw on screen. Shipping a second rendering engine to
   * redraw the same thing would be a megabyte of dependency and a new way for
   * the paper and the screen to disagree.
   */
  const printReport = useCallback(() => {
    if (phase !== "report") return;
    window.print();
  }, [phase]);

  /**
   * Save run (PRD 6.3, page 6 - "Save run", "run-history list enabling
   * side-by-side reruns").
   *
   * Saving puts the run in the history table *and* writes a row to the ledger,
   * because a saved evidence run is a claim somebody made at a moment in time
   * and the whole product's argument is that those are recorded.
   */
  const saveRun = useCallback(() => {
    const id = `SIM-${String(config.seed).padStart(4, "0")}-S${saved.length + 1}`;
    const tugboatArm = report.arms.find((arm) => arm.key === "tugboat");

    const run: SavedRun = {
      id,
      seed: config.seed,
      batchSize: config.batchSize,
      difficulty: config.difficulty,
      policyVersion: "v4",
      recoveredPaise: report.headline.recoveredPaise,
      recoveryRate: report.headline.recoveryRate,
      baselineRate: report.headline.baselineRate,
      accuracy: report.grading.accuracy,
      costPer100Paise: tugboatArm?.costPer100Paise ?? 0,
      ranMinutesAgo: 0,
    };

    setSaved((current) => [run, ...current]);

    appendEvent({
      chain: "policy",
      caseId: null,
      actor: "HUMAN",
      action: "EVIDENCE_RUN_SAVED",
      detail: `${id} saved · seed ${config.seed} · ${config.batchSize} cases`,
      tip,
      payload: {
        run_id: id,
        seed: config.seed,
        batch_size: config.batchSize,
        difficulty: config.difficulty,
        arms: config.arms,
        recovered_paise: run.recoveredPaise,
        recovery_rate: Number(run.recoveryRate.toFixed(4)),
        baseline_rate: Number(run.baselineRate.toFixed(4)),
        diagnosis_accuracy: Number(run.accuracy.toFixed(4)),
        saved_by: "Demo Merchant",
      },
    });

    flash(`${id} saved to the run history and written to the ledger`);
  }, [config, flash, report, saved.length, tip]);

  /** Saved-this-session runs first, then the shipped history. */
  const runs = useMemo(() => [...saved, ...report.runs], [saved, report.runs]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The counterpart of the Control Tower's live badge: this run is
            fixed, and the whole value of it is that it does not move. */}
        <p className="mono flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-txt-faint">
          <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-[rgba(154,234,255,0.32)] px-2 py-[2px] text-diagnosis">
            PINNED EVIDENCE RUN
          </span>
          <span>
            {phase === "running"
              ? `running · seed ${config.seed} · ${config.arms.length} arms · ${config.batchSize} cases`
              : `seed ${config.seed} · ${report.headline.cases} cases · ${report.grading.graded} diagnoses graded · reruns identical`}
          </span>
        </p>

        <div className="no-print flex flex-wrap items-center gap-2.5">
          {phase === "report" ? (
            <>
              <button type="button" className="btn-op-quiet" onClick={saveRun}>
                <CheckIcon className="h-[12px] w-[12px]" />
                Save run
              </button>
              <button type="button" className="btn-op-quiet" onClick={download}>
                <DownloadIcon className="h-[12px] w-[12px]" />
                Report · JSON
              </button>
              <button type="button" className="btn-op-quiet" onClick={printReport}>
                <DownloadIcon className="h-[12px] w-[12px]" />
                Report · PDF
              </button>
            </>
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
          <RunHistory runs={runs} />
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

      {note ? (
        <p className="no-print mono rounded-[2px] border border-[rgba(255,232,134,0.3)] px-3 py-2 text-[11.5px] text-waiting">
          {note}
        </p>
      ) : null}

      {phase === "report" ? (
        <>
          {/* Only on paper: a printed report leaves the app behind, so it has
              to carry its own provenance. */}
          <p className="print-only mono text-[11px]">
            Tugboat evidence report · pinned run · seed {config.seed} · {config.batchSize} cases ·
            policy v4 · tugboat@0.4.0 · reruns of this seed reproduce these figures exactly.
          </p>
          <EvidenceReport config={config} report={report} executed={defaultConfig} runs={runs} />
        </>
      ) : null}
    </div>
  );
}
