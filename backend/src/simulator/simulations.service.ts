import {
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { CaseType, Prisma, SimRun } from "@prisma/client";

import { ClockService } from "../common/clock.service";
import type { RunTotals } from "../common/domain-event";
import { DomainEventsService } from "../common/domain-events.service";
import type { SimulationReport } from "../metrics/report.service";
import { ReportService } from "../metrics/report.service";
import { PolicyService } from "../policy/policy.service";
import { PrismaService } from "../prisma/prisma.service";
import { BatchRunnerService, type RunConfig, type RunStep } from "./batch-runner.service";
import { DIFFICULTY, type DifficultyKey } from "./difficulty";
import type { ArmKey } from "./counterfactuals";
import type { GeneratedCase } from "./population";

/**
 * A simulation run, from the button to the artifact.
 *
 * The run happens in the background and the endpoint returns immediately,
 * because a batch that covers ten simulated days of policy takes minutes of
 * real time and an HTTP request that waits for it is a request that times out
 * behind a proxy nobody controls. Progress is written to the row as the batch
 * moves, which is what the Simulation Lab polls today and what the Stage 9
 * socket will push.
 *
 * A finished run is not automatically what the Control Tower shows. Promotion
 * is a separate, explicit act: pressing Run in the lab must not silently
 * replace the batch a merchant was in the middle of presenting, and a demo that
 * can be destroyed by a stray click is a demo that will be.
 */

/** Before the first milestone lands, the batch has genuinely done nothing. */
const EMPTY_TOTALS: RunTotals = {
  recoveredPaise: 0,
  recoveredCases: 0,
  contacts: 0,
  escalations: 0,
  stopped: 0,
};

/** The batch sizes the runner offers, mirroring the lab's own control. */
export const BATCH_SIZES = [100, 214, 500];

/**
 * How often a running batch writes the wall-clock time to its row, and how
 * long without one before the run is presumed dead.
 *
 * Six missed beats. A tick of the batch can hold the event loop for a while —
 * a dozen cases through their transactions against a database an ocean away —
 * so one missed beat is a busy process, not a dead one. Ninety seconds without
 * any is neither. The stale bound is real time, never the batch's shifted
 * clock: the question is whether a process is alive, not what day the
 * simulation thinks it is (D-129).
 */
export const HEARTBEAT_MS = 15_000;
export const STALE_AFTER_MS = 90_000;
const SWEEP_MS = 60_000;

export type SavedRun = {
  id: string;
  seed: number;
  batchSize: number;
  difficulty: DifficultyKey;
  policyVersion: string;
  recoveredPaise: number;
  recoveryRate: number;
  baselineRate: number;
  accuracy: number;
  costPer100Paise: number;
  ranMinutesAgo: number;
  status: string;
  /** The run the Control Tower is currently narrating. */
  current?: boolean;
};

export type CreateSimulationInput = {
  batchSize: number;
  mix: Record<CaseType, number>;
  difficulty: DifficultyKey;
  seed: number;
  arms: ArmKey[];
};

@Injectable()
export class SimulationsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SimulationsService.name);

  /** Runs started in this process, so a second Run press does not double-fire. */
  private readonly running = new Set<string>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: BatchRunnerService,
    private readonly report: ReportService,
    private readonly policy: PolicyService,
    private readonly clock: ClockService,
    private readonly domain: DomainEventsService,
  ) {}

  /**
   * A run whose process died is a run nobody is working.
   *
   * Runs live in memory for their whole duration, so a `RUNNING` row whose
   * process is gone — killed, crashed, or redeployed — will never advance.
   * Left alone it sits at 41% forever, and the Simulation Lab shows a batch in
   * flight that is not. Marking it failed is the honest reading, and the cases
   * it did produce are kept: they are a real partial batch and deleting them
   * would destroy the evidence of what went wrong.
   *
   * "Gone" is decided by the heartbeat, not by this process having just
   * started. The first version reaped every RUNNING row at boot, which was
   * right for one process and wrong the moment a second one — a test suite,
   * a redeploy overlapping the old instance — booted against the same
   * database while a batch was in flight (B-47). Swept on a timer as well, so
   * a run whose process died is marked while nobody is restarting anything.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.reapStale();

    this.sweeper = setInterval(() => {
      void this.reapStale().catch((error) => {
        this.logger.error(`Orphan sweep failed: ${(error as Error).message}`);
      });
    }, SWEEP_MS);
    this.sweeper.unref();
  }

  onApplicationShutdown(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  async reapStale(now: Date = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);

    const orphaned = await this.prisma.simRun.updateMany({
      where: {
        status: { in: ["RUNNING", "QUEUED"] },
        id: { notIn: [...this.running] },
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          // Never beat at all: queued and abandoned, or started by a build that
          // wrote no heartbeat. Judged by age rather than reaped on sight.
          { heartbeatAt: null, createdAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: "FAILED",
        finishedAt: this.clock.now(),
        failureReason: "The process running this batch stopped reporting before it finished.",
      },
    });

    if (orphaned.count > 0) {
      this.logger.warn(`Marked ${orphaned.count} orphaned simulation run(s) as failed`);
    }

    return orphaned.count;
  }

  async create(merchantId: string, input: CreateSimulationInput): Promise<SimRun> {
    const { id: policyVersionId } = await this.policy.getActive(merchantId);

    const run = await this.prisma.simRun.create({
      data: {
        merchantId,
        ref: await this.nextRef(merchantId, input.seed),
        seed: input.seed,
        batchSize: input.batchSize,
        mix: input.mix as unknown as Prisma.InputJsonValue,
        difficulty: input.difficulty,
        // TUGBOAT is always in the list whatever was asked for: a report
        // without the arm under test is not a report.
        arms: [...new Set([...input.arms, "tugboat"])],
        policyVersionId,
        status: "QUEUED",
      },
    });

    // Deliberately not awaited. The failure path is inside `execute`, which
    // writes the reason to the row rather than letting it die in a log nobody
    // reads — an unhandled rejection here would leave a run QUEUED forever.
    void this.execute(run.id).catch((error) => {
      this.logger.error(`Run ${run.ref} failed outside its own handler: ${(error as Error).message}`);
    });

    return run;
  }

  async execute(runId: string): Promise<void> {
    if (this.running.has(runId)) {
      this.logger.warn(`Run ${runId} is already in flight; ignoring the second start`);
      return;
    }
    this.running.add(runId);

    const run = await this.prisma.simRun.findUniqueOrThrow({ where: { id: runId } });
    const startedAt = this.clock.now();

    // Outside the shifted frame on purpose: the beat is this process saying
    // "still here" in wall-clock time, whatever day the batch is on.
    const heartbeat = setInterval(() => {
      void this.prisma.simRun
        .updateMany({ where: { id: runId, status: "RUNNING" }, data: { heartbeatAt: new Date() } })
        .catch((error) => {
          this.logger.warn(`Heartbeat for ${run.ref} failed: ${(error as Error).message}`);
        });
    }, HEARTBEAT_MS);
    heartbeat.unref();

    try {
      await this.prisma.simRun.update({
        where: { id: runId },
        data: {
          status: "RUNNING",
          startedAt,
          progress: 0,
          failureReason: null,
          heartbeatAt: new Date(),
        },
      });

      const { pack, version } = await this.policy.getActive(run.merchantId);

      const config: RunConfig = {
        batchSize: run.batchSize,
        mix: run.mix as unknown as Record<CaseType, number>,
        difficulty: run.difficulty as DifficultyKey,
        seed: run.seed,
        arms: run.arms,
      };

      const steps: RunStep[] = [];
      // The counters the Lab draws beside the bar. Refreshed on a milestone
      // rather than on every frame, and carried forward in between: the numbers
      // are four aggregate queries, and a batch that answered them sixty times
      // a second would spend more of its connection pool narrating itself than
      // working cases (D-107).
      let totals: RunTotals = EMPTY_TOTALS;

      const outcome = await this.runner.run(runId, run.merchantId, config, async (progress, step) => {
        if (step) steps.push(step);
        // Written on a milestone or every tenth of the way, not on every
        // percent: the row is the fallback a reconnecting browser reads, and
        // two hundred writes to it would cost more than the batch does.
        if (step || progress % 10 === 0) {
          await this.prisma.simRun.update({
            where: { id: runId },
            data: { progress, steps: steps as unknown as Prisma.InputJsonValue },
          });
        }

        if (step) totals = await this.totalsFor(runId);

        this.domain.publish({
          name: "sim.progress",
          merchantId: run.merchantId,
          runId: run.ref,
          progress: progress / 100,
          step: step ?? null,
          totals,
        });
      });

      await this.writeGroundTruth(runId, outcome.caseIds);

      const report = await this.report.build({
        runId,
        ref: run.ref,
        merchantId: run.merchantId,
        seed: run.seed,
        difficulty: config.difficulty,
        mix: config.mix,
        arms: run.arms as ArmKey[],
        policyVersion: version,
        pack,
        population: outcome.cases,
        personaByCaseId: outcome.caseIds,
        caseErrors: outcome.errors.length,
        startedAtMs: outcome.startedAtMs,
        horizonMs: outcome.horizonMs,
      });

      await this.prisma.simRun.update({
        where: { id: runId },
        data: {
          status: "COMPLETED",
          progress: 100,
          finishedAt: this.clock.now(),
          report: report as unknown as Prisma.InputJsonValue,
          headline: report.headline as unknown as Prisma.InputJsonValue,
          steps: steps as unknown as Prisma.InputJsonValue,
        },
      });

      this.domain.publish({
        name: "sim.completed",
        merchantId: run.merchantId,
        runId: run.ref,
        status: "COMPLETED",
        failureReason: null,
      });

      this.logger.log(
        `Run ${run.ref} completed · ${report.headline.recoveredCases}/${report.headline.cases} recovered · ` +
          `${(report.headline.recoveryRate * 100).toFixed(1)}% of value · ` +
          `diagnosis ${(report.diagnosis.accuracy * 100).toFixed(1)}% · ` +
          `${outcome.errors.length} case-level errors`,
      );
    } catch (error) {
      const reason = (error as Error).message;
      this.logger.error(`Run ${run.ref} failed: ${reason}`);

      // A failed run keeps its cases. They are a real, partial batch and
      // deleting them would destroy the evidence of what went wrong.
      await this.prisma.simRun.update({
        where: { id: runId },
        data: { status: "FAILED", finishedAt: this.clock.now(), failureReason: reason },
      });

      // The Lab is watching a bar that will never reach 100. It is told why
      // here rather than left to time out into a blank report.
      this.domain.publish({
        name: "sim.completed",
        merchantId: run.merchantId,
        runId: run.ref,
        status: "FAILED",
        failureReason: reason,
      });
    } finally {
      clearInterval(heartbeat);
      this.running.delete(runId);
    }
  }

  /**
   * What the batch has actually done so far, counted from its own rows.
   *
   * Not interpolated from the finished report the way the seeded replay was:
   * these are the cases this run has really closed, the contacts it has really
   * sent and the escalations it has really raised, at this moment. That
   * distinction is the whole reason the progress bar is worth watching — a bar
   * whose counters are a fraction of a known answer is an animation.
   */
  private async totalsFor(runId: string): Promise<RunTotals> {
    const [money, recoveredCases, contacts, escalations, stopped] = await Promise.all([
      this.prisma.case.aggregate({
        where: { simRunId: runId },
        _sum: { recoveredAmountPaise: true },
      }),
      this.prisma.case.count({ where: { simRunId: runId, stage: "recovered" } }),
      // Retries are not contacts: nobody's phone lights up for one, which is
      // exactly why the ladder opens with them.
      this.prisma.action.count({
        where: { case: { simRunId: runId }, status: "EXECUTED", channel: { not: "RETRY" } },
      }),
      this.prisma.approval.count({ where: { case: { simRunId: runId } } }),
      this.prisma.case.count({
        where: { simRunId: runId, stage: { in: ["halted", "exhausted"] } },
      }),
    ]);

    return {
      recoveredPaise: money._sum.recoveredAmountPaise ?? 0,
      recoveredCases,
      contacts,
      escalations,
      stopped,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  async list(merchantId: string): Promise<SavedRun[]> {
    const runs = await this.prisma.simRun.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { policyVersion: { select: { version: true } } },
    });

    return runs.map((run) => this.toSavedRun(run));
  }

  /**
   * The landing page's four figures, from the promoted run.
   *
   * Zeros with no promoted run, and the page says "no run yet" rather than
   * drawing a plausible number. The alternative — shipping the last good
   * figures as constants — is how a landing page ends up quoting a batch that
   * no longer exists.
   */
  async publicHeadline() {
    const run = await this.prisma.simRun.findFirst({
      where: { promotedAt: { not: null }, status: "COMPLETED" },
      orderBy: { promotedAt: "desc" },
      select: { ref: true, seed: true, report: true },
    });

    const report = run?.report as unknown as SimulationReport | null;

    if (!run || !report) {
      return {
        runId: null,
        seed: null,
        recoveryRate: 0,
        upliftPoints: 0,
        accuracy: 0,
        atRiskPaise: 0,
        cases: 0,
      };
    }

    return {
      runId: run.ref,
      seed: run.seed,
      recoveryRate: report.headline.recoveryRate,
      upliftPoints: report.headline.upliftPoints,
      accuracy: report.diagnosis.accuracy,
      atRiskPaise: report.headline.atRiskPaise,
      cases: report.headline.cases,
    };
  }

  async status(merchantId: string, idOrRef: string) {
    const run = await this.find(merchantId, idOrRef);

    return {
      id: run.ref,
      status: run.status,
      progress: run.progress,
      seed: run.seed,
      batchSize: run.batchSize,
      difficulty: run.difficulty,
      arms: run.arms,
      steps: (run.steps as unknown as RunStep[]) ?? [],
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      failureReason: run.failureReason,
      current: run.promotedAt !== null,
    };
  }

  async reportFor(merchantId: string, idOrRef: string): Promise<SimulationReport> {
    const run = await this.find(merchantId, idOrRef);

    if (!run.report) {
      throw new NotFoundException({
        error: `Run ${run.ref} is ${run.status.toLowerCase()} and has no report yet.`,
      });
    }

    return run.report as unknown as SimulationReport;
  }

  /**
   * Makes one run the batch the Control Tower narrates.
   *
   * The previous demo dataset is cleared rather than left beside it, because
   * two batches in one pipeline is two sets of KPIs summed into a number that
   * describes neither. Cases from earlier runs go; a hand-seeded set from
   * `db:seed` goes too, which is the point of the stage — the whole product
   * ends up narrating one real run rather than a fixture.
   */
  async promote(merchantId: string, idOrRef: string) {
    const run = await this.find(merchantId, idOrRef);

    if (run.status !== "COMPLETED") {
      throw new NotFoundException({
        error: `Run ${run.ref} is ${run.status.toLowerCase()}; only a completed run can be promoted.`,
      });
    }

    // Only other batches are cleared. A live case — a real webhook, a real
    // customer — is narrated beside the promoted batch (D-120), and promoting
    // an experiment must never delete the merchant's actual work (B-66, D-141).
    const removed = await this.prisma.case.deleteMany({
      where: { merchantId, simRunId: { not: null }, NOT: { simRunId: run.id } },
    });

    await this.prisma.simRun.updateMany({
      where: { merchantId, promotedAt: { not: null } },
      data: { promotedAt: null },
    });

    await this.prisma.simRun.update({
      where: { id: run.id },
      data: { promotedAt: this.clock.now() },
    });

    this.logger.log(`Promoted ${run.ref} to the demo dataset · ${removed.count} cases from other batches cleared`);

    return { id: run.ref, promoted: true, clearedCases: removed.count };
  }

  /* ---------------------------------------------------------------- */

  /**
   * The answer key, written after the run rather than during it.
   *
   * Written at all only because grading needs a join: the persona is already in
   * memory while the batch runs, and persisting it means a report can be
   * regenerated, and a reviewer can read what each customer was actually like
   * beside what the agent concluded. It lands in `sim_ground_truth`, which no
   * module the agent can reach has a query against (ADR-10).
   */
  private async writeGroundTruth(
    runId: string,
    caseIds: Map<number, GeneratedCase>,
  ): Promise<void> {
    const rows = [...caseIds.entries()].map(([caseId, generated]) => ({
      simRunId: runId,
      caseId,
      caseIndex: generated.index,
      trueRootCause: generated.persona.trueRootCause,
      personaSummary: generated.persona.summary,
      personaJson: {
        disposition: generated.persona.disposition,
        responsiveness: generated.persona.responsiveness,
        silentConversion: generated.persona.silentConversion,
        patience: generated.persona.patience,
        complaintThreshold: generated.persona.complaintThreshold,
        fundsAvailableAfterHours: Number.isFinite(generated.persona.fundsAvailableAfterHours)
          ? generated.persona.fundsAvailableAfterHours
          : null,
        selfRecoverAfterHours: generated.persona.selfRecoverAfterHours,
        observableLane: generated.observable.lane,
      } as unknown as Prisma.InputJsonValue,
      wouldSelfRecover: generated.persona.wouldSelfRecover,
    }));

    // Skips duplicates so a re-run of `execute` on the same row is repairable
    // rather than fatal.
    await this.prisma.simGroundTruth.createMany({ data: rows, skipDuplicates: true });
  }

  private async find(merchantId: string, idOrRef: string) {
    const run = await this.prisma.simRun.findFirst({
      where: { merchantId, OR: [{ id: idOrRef }, { ref: idOrRef }] },
    });

    if (!run) throw new NotFoundException({ error: `Simulation ${idOrRef} not found.` });
    return run;
  }

  /** "SIM-0042-C" — the seed, then a letter per run of that seed. */
  private async nextRef(merchantId: string, seed: number): Promise<string> {
    const existing = await this.prisma.simRun.count({ where: { merchantId, seed } });
    const suffix = String.fromCharCode(65 + (existing % 26));

    return `SIM-${String(seed).padStart(4, "0")}-${suffix}${existing >= 26 ? existing : ""}`;
  }

  private toSavedRun(
    run: SimRun & { policyVersion: { version: string } | null },
  ): SavedRun {
    const report = run.report as unknown as SimulationReport | null;
    const tugboat = report?.arms.find((arm) => arm.key === "tugboat");

    return {
      id: run.ref,
      seed: run.seed,
      batchSize: report?.run.batchSize ?? run.batchSize,
      difficulty: run.difficulty as DifficultyKey,
      policyVersion: run.policyVersion?.version ?? "—",
      recoveredPaise: report?.headline.recoveredPaise ?? 0,
      recoveryRate: report?.headline.recoveryRate ?? 0,
      baselineRate: report?.headline.baselineRate ?? 0,
      accuracy: report?.diagnosis.accuracy ?? 0,
      costPer100Paise: tugboat?.costPer100Paise ?? 0,
      ranMinutesAgo: Math.max(
        0,
        Math.round((this.clock.nowMs() - (run.finishedAt ?? run.createdAt).getTime()) / 60_000),
      ),
      status: run.status,
      ...(run.promotedAt ? { current: true } : {}),
    };
  }
}

export { DIFFICULTY };
