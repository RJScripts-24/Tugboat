"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { DownloadIcon, PlayIcon, RetryIcon } from "@/components/dashboard/icons";
import { promoteSimulation, startSimulation } from "@/lib/actions";
import { useSimRun } from "@/lib/live";
import type { EvidenceReport, SavedRun, SimulationConfig } from "@/lib/simulation-data";
import { EvidenceReport as EvidenceReportView, type Report } from "./evidence-report";
import { HonestyCard, ReportContents, RunConfig } from "./run-config";
import { RunHistory } from "./run-history";
import { RunProgress } from "./run-progress";

/** How long a receipt stays on screen. Matched to the other two write surfaces. */
const NOTE_MS = 8_000;

type Phase = "configure" | "running" | "report";

/**
 * The Simulation Lab (PRD 6.3, page 6) — the evidence page.
 *
 * Three states in one component because they are one thing: a configuration,
 * the run it produces, and the report that run leaves behind. Splitting them
 * across routes would let a panelist arrive at a headline number with no
 * statement of what produced it, which is the failure mode this whole page
 * exists to avoid.
 *
 * The run is real. It used to be a replay: a `requestAnimationFrame` loop
 * advancing a bar over 8.6 seconds while the counters interpolated toward a
 * report that had already been computed, with a fixed script of runner lines
 * pinned to fractions of the batch. Pressing Run now posts a `SimulationConfig`
 * to the API, which answers 202 with a run id, and this component subscribes to
 * that run's own socket room. The bar moves because cases are being worked; the
 * counters are cases really closed and contacts really sent; and the whole
 * thing takes minutes rather than seconds, because a 214-case batch against a
 * hosted database is roughly thirty round trips per case (D-116).
 *
 * That is the trade the page makes on purpose. A direct-insert generator would
 * finish in seconds and prove nothing.
 */
export function SimulationLab({
  defaultConfig,
  report,
  runs,
}: {
  defaultConfig: SimulationConfig;
  /** Null before any batch has completed — the page says so rather than drawing an empty one. */
  report: EvidenceReport | null;
  runs: SavedRun[];
}) {
  const router = useRouter();
  const [config, setConfig] = useState<SimulationConfig>(defaultConfig);
  const [phase, setPhase] = useState<Phase>(report ? "report" : "configure");
  const [runId, setRunId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const frame = useSimRun(phase === "running" ? runId : null);

  const flash = useCallback((message: string) => {
    setNote(message);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
  }, []);

  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );

  /**
   * The run finished while we were watching it.
   *
   * `router.refresh()` rather than a fetch of the report here: the page's
   * server function already knows how to find the newest completed run and read
   * its artifact, and asking it again is one implementation of that rather than
   * two.
   */
  useEffect(() => {
    if (phase !== "running") return;

    if (frame.status === "completed") {
      setPhase("report");
      router.refresh();
      flash(`${runId} completed — the report below is this run's own artifact`);
      return;
    }

    if (frame.status === "failed") {
      setPhase("configure");
      router.refresh();
      // Named rather than swallowed. A run that died keeps the cases it did
      // produce, because they are a real partial batch and deleting them would
      // destroy the evidence of what went wrong.
      flash(`${runId} failed — ${frame.failureReason ?? "no reason recorded"}`);
    }
  }, [flash, frame.failureReason, frame.status, phase, router, runId]);

  const run = useCallback(() => {
    startTransition(async () => {
      const result = await startSimulation(config);

      if (!result.ok) {
        flash(`The batch did not start — ${result.error}`);
        return;
      }

      setRunId(result.data.id);
      setPhase("running");
      flash(`${result.data.id} accepted — ${config.batchSize} cases on seed ${config.seed}`);
    });
  }, [config, flash]);

  /**
   * Cancelling stops watching, not the batch.
   *
   * Said plainly in the receipt, because the honest thing this button can do is
   * leave the room: the run is a background process on the server working real
   * cases through the real gate, and a browser closing a socket has no business
   * killing it half way through a case.
   */
  const stopWatching = useCallback(() => {
    setPhase(report ? "report" : "configure");
    flash(`Stopped watching ${runId} — the batch is still running on the server`);
  }, [flash, report, runId]);

  /**
   * The report as a file (PRD 6.3, page 6 · PRD 12).
   *
   * The artifact itself, byte for byte — no longer rebuilt in the browser from
   * the numbers on screen. There is nothing left to rebuild it from that is not
   * this object, which is the point: the file a judge downloads and the file the
   * repository commits are the same JSON the API stored on the run row.
   */
  const download = useCallback(() => {
    if (!report) return;

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tugboat-batch-seed-${report.run.seed}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    flash(`tugboat-batch-seed-${report.run.seed}.json downloaded`);
  }, [flash, report]);

  const printReport = useCallback(() => {
    if (phase !== "report") return;
    window.print();
  }, [phase]);

  /**
   * Promote (D-94) — make this run the batch the Control Tower narrates.
   *
   * Destructive and deliberately separate from running one: it clears whatever
   * the pipeline was showing, and pressing Run in the lab must not silently
   * replace the batch a merchant is in the middle of presenting.
   */
  const promote = useCallback(() => {
    if (!report) return;

    startTransition(async () => {
      const result = await promoteSimulation(report.run.id);

      if (!result.ok) {
        flash(`Could not promote ${report.run.id} — ${result.error}`);
        return;
      }

      router.refresh();
      flash(
        `${report.run.id} is now the batch the Control Tower narrates · ${result.data.clearedCases} older cases cleared`,
      );
    });
  }, [flash, report, router]);

  /** The report's blocks, under the names this page's components already use. */
  const view: Report | null = useMemo(
    () =>
      report
        ? {
            headline: report.headline,
            arms: report.arms,
            byType: report.byCaseType,
            grading: report.diagnosis,
            rules: report.stoppingRules,
            compliance: report.compliance,
            escalations: report.escalations,
            exceptions: report.exceptions,
            runs,
          }
        : null,
    [report, runs],
  );

  const tugboat = report?.arms.find((arm) => arm.key === "tugboat");
  const current = runs.find((row) => row.current);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-txt-faint">
          {/* The counterpart of the Control Tower's live badge: a finished run
              is fixed, and the whole value of it is that it does not move. */}
          <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-[rgba(154,234,255,0.32)] px-2 py-[2px] text-diagnosis">
            {phase === "running" ? "BATCH RUNNING" : "PINNED EVIDENCE RUN"}
          </span>
          <span>
            {phase === "running"
              ? `${runId} · seed ${config.seed} · ${config.batchSize} cases · ${config.arms.length} arms`
              : report
                ? `${report.run.id} · seed ${report.run.seed} · ${report.headline.cases} cases · ${report.diagnosis.graded} diagnoses graded · reruns of this seed reproduce these figures`
                : "no completed run yet · configure a batch and press Run"}
          </span>
        </p>

        <div className="no-print flex flex-wrap items-center gap-2.5">
          {phase === "report" && report ? (
            <>
              <button
                type="button"
                className="btn-op-quiet"
                onClick={promote}
                disabled={busy || current?.id === report.run.id}
              >
                <RetryIcon className="h-[12px] w-[12px]" />
                {current?.id === report.run.id ? "Narrated by the Tower" : "Promote to demo batch"}
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

          {phase === "configure" && report ? (
            <button type="button" className="btn-op-quiet" onClick={() => setPhase("report")}>
              Open the last report
            </button>
          ) : null}

          {phase === "running" ? null : (
            <button
              onClick={run}
              disabled={busy}
              className="btn-gold gap-2.5 px-6 py-[11px] text-[14.5px]"
            >
              {phase === "report" ? (
                <RetryIcon className="h-[13px] w-[13px]" />
              ) : (
                <PlayIcon className="h-[12px] w-[12px]" />
              )}
              {busy ? "Starting…" : phase === "report" ? "Run again" : "Run batch"}
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
                atRiskPaise={report?.headline.atRiskPaise ?? 0}
                cases={report?.headline.cases ?? 0}
                contacts={tugboat?.contacts ?? 0}
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
          progress={frame.progress}
          totals={frame.totals}
          steps={frame.steps}
          onCancel={stopWatching}
        />
      ) : null}

      {note ? (
        <p className="no-print mono rounded-[2px] border border-[rgba(255,232,134,0.3)] px-3 py-2 text-[11.5px] text-waiting">
          {note}
        </p>
      ) : null}

      {phase === "report" && report && view ? (
        <>
          {/* Only on paper: a printed report leaves the app behind, so it has
              to carry its own provenance. */}
          <p className="print-only mono text-[11px]">
            Tugboat evidence report · {report.run.id} · seed {report.run.seed} ·{" "}
            {report.run.batchSize} cases · policy {report.run.policyVersion} ·{" "}
            {report.run.codeVersion} · reruns of this seed reproduce these figures.
          </p>
          <EvidenceReportView
            config={config}
            report={view}
            executed={defaultConfig}
            provenance={report.run}
            runs={runs}
          />
        </>
      ) : null}
    </div>
  );
}
