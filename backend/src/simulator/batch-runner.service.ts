import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CaseType } from "@prisma/client";

import { DetectorService } from "../agent-core/detector.service";
import { ExecutorService } from "../agent-core/executor.service";
import { ApprovalsService } from "../approvals/approvals.service";
import { ClockService, type ClockFrame } from "../common/clock.service";
import { InboundService } from "../conversation/inbound.service";
import { IngestionService } from "../ingestion/ingestion.service";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE, type ActionQueue, type QueuedJob } from "../queue/action-queue.interface";
import type { InlineActionQueue } from "../queue/inline-action-queue";
import { batchQueueOf } from "../queue/routed-action-queue";
import { type DifficultyKey } from "./difficulty";
import { decideAs, SIMULATED_APPROVER } from "./merchant-persona";
import {
  reactTo,
  retryCaptures,
  unpromptedPaymentAt,
  voiceCounterpart,
  type Reaction,
} from "./persona-engine";
import { buildPopulation, type GeneratedCase } from "./population";
import { SeededRng } from "./seeded-rng";

/**
 * The batch, executed.
 *
 * Everything here rests on one rule: the simulator enters through the doors the
 * outside world uses. A generated case reaches the agent as a `NormalizedEvent`
 * through `IngestionService.ingest`, exactly as a Razorpay webhook does; a
 * persona's reply arrives through `InboundService.handle`, exactly as a Twilio
 * callback will; a payment lands through `IngestionService.recordPayment`,
 * exactly as `payment.captured` will. There is no code path that only synthetic
 * traffic can reach, which is what makes a measurement of the batch a
 * measurement of the product (ADR-10).
 *
 * The second rule is that time is the agent's, not the process's. The whole run
 * happens inside one shifted clock frame: the agent believes it is ten days ago
 * and works forward, so a 20-hour cool-down really elapses, quiet hours really
 * arrive, and a mandate really waits three days between re-presentations. None
 * of that is stubbed or scaled — the same gate code runs against the same
 * thresholds, and the only thing that changed is what `now` returns.
 *
 * The loop is event-driven rather than ticked. It jumps to the next instant at
 * which *something* is due — an arrival, a queued job, a customer's reply — and
 * does everything due at that instant. A fixed tick would either miss detail or
 * spend most of the run asking an empty queue whether it had anything yet.
 *
 * That instant is then rounded up onto the hour. Not for realism: for
 * throughput. A batch of two hundred cases has its work spread across two
 * hundred slightly different instants, and visiting each alone turns a run that
 * could overlap its round trips into one that takes them strictly in turn. An
 * hour is far coarser than anything the run needs to resolve and far finer than
 * anything the policy expresses — the shortest bound in the pack is the
 * twenty-hour cool-down, and the quiet window opens and closes on the hour.
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How much simulated time a run covers, and how much of it new cases arrive in.
 *
 * Ten days is chosen from the bounds themselves rather than picked round: four
 * attempts twenty hours apart is three and a half days, three mandate
 * re-presentations three days apart is nine, and a promise books three days
 * out. A window shorter than the longest playbook would report cases as
 * unfinished that the policy simply had not finished with yet.
 */
const WINDOW_MS = 10 * DAY_MS;
const ARRIVAL_WINDOW_MS = 3 * DAY_MS;

/**
 * Where a run's simulated clock starts — a constant, not the wall clock.
 *
 * This was `Date.now()`, and that quietly falsified the one claim the batch
 * exists to make. Every bound the gate enforces is a statement about the time
 * of day: a run started at 22:00 defers its first rung to 09:00 and a run
 * started at 14:00 sends it immediately. So the same seed produced the same
 * recoveries with a different number of contacts, deferrals and ledger rows
 * depending on when somebody pressed Run — the personas agreed, the clock did
 * not, and "same seed twice ⇒ byte-identical report" held only by luck.
 *
 * `setSimTime` below already fixes this hazard *inside* a tick, for exactly the
 * reason recorded in B-35. This is the same bug one level up.
 *
 * The instant is chosen rather than arbitrary. The window closes on 5 August
 * and therefore opens on 26 July, which puts a payday — 10:00 IST on the 1st —
 * inside it, so `alignToPayday` is a rule the batch actually exercises instead
 * of one that can never fire, and keeps a promoted batch recent enough to read
 * as this project's own work rather than as an archive. It is deliberately not
 * seed-derived: a calendar that moves with the seed is a second knob over the
 * headline, and D-85 is already the argument for having as few as possible.
 *
 * The cost is stated rather than hidden: a promoted batch carries simulated
 * dates that do not track real time. The Control Tower's live feel comes from
 * the socket stream, not from the batch's timestamps (D-97).
 */
const SIM_ANCHOR_MS = Date.UTC(2026, 7, 5, 3, 30); // 2026-08-05 09:00 IST

/**
 * Background payment attempts per simulated hour, so the detector has a
 * denominator. Sized to the batch: two hundred failures in three days at a
 * five-percent failure rate is a merchant taking about sixty payments an hour.
 * The old nine could never fill the monitor's minimum window, so the dip was
 * drawn on the chart but never detected (B-67).
 */
const BASE_TRAFFIC_PER_HOUR = 60;

/**
 * Cases worked at once.
 *
 * Bounded by the database rather than by correctness: every case in a batch is
 * an independent conversation, already safe against the others through the gate
 * and the idempotency key, and the run is entirely network-bound on a pooled
 * connection to a hosted Postgres. Serial, a two-hundred-case batch spends
 * twenty minutes waiting on round trips it could have overlapped.
 */
const CONCURRENCY = 12;

/** A runaway guard: no batch of this size legitimately runs a million jobs. */
const MAX_JOBS_PER_DRAIN = 20_000;

/** Simulated instants are visited on the hour, so a slot's work overlaps. */
const TICK_GRID_MS = HOUR_MS;
/**
 * How often the degradation monitor is asked on the simulated clock. In
 * production every recorded outcome asks it, successes included; the batch
 * seeds its successes up front, so without this sweep the monitor was asked
 * only when a failure arrived — and one quiet hour let an outage become its
 * own baseline before anyone looked (B-67).
 */
const MONITOR_STEP_MS = 15 * 60_000;

export type RunConfig = {
  batchSize: number;
  mix: Record<CaseType, number>;
  difficulty: DifficultyKey;
  seed: number;
  arms: string[];
};

export type RunStep = {
  /** Fraction of the batch processed when this line lands. */
  at: number;
  actor: "BOA" | "POLICY" | "RECOVERY";
  line: string;
  meta: string;
};

type PendingReaction = Reaction & { caseId: number; simIndex: number; seq: number };

/** One case that threw, kept so the report can say so rather than round it off. */
export type RunError = { caseId: number | null; stage: string; reason: string };

/** Past this many failures the run is not degraded, it is broken. */
const MAX_ERRORS = 40;

@Injectable()
export class BatchRunnerService {
  private readonly logger = new Logger(BatchRunnerService.name);

  /** Monotonic across a run, so two reactions never share an identity. */
  private reactionSeq = 0;

  /**
   * Sends already turned into reactions, by action id.
   *
   * The scan below is inclusive at its lower bound, because with time frozen
   * inside a tick every send carries the tick's exact instant and the previous
   * watermark *is* that instant (B-48). Inclusive means a tick that repeats an
   * instant — a job enqueued for "now" during the second drain — would see the
   * same rows twice, and a customer would reply to one message twice. The set
   * is what makes the scan idempotent; reset at the start of every run.
   */
  private collectedActions = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly ingestion: IngestionService,
    private readonly inbound: InboundService,
    private readonly executor: ExecutorService,
    private readonly detector: DetectorService,
    private readonly approvals: ApprovalsService,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
  ) {}

  /**
   * Runs the TUGBOAT arm end to end and returns the batch it produced.
   *
   * The counterfactual arms are not run here, because there is nothing to run:
   * see `counterfactuals.ts`. What comes back is the generated population with
   * its case ids attached, which is everything the evaluator needs to join the
   * agent's own record against the truth it was never shown.
   */
  async run(
    runId: string,
    merchantId: string,
    config: RunConfig,
    onProgress?: (progress: number, step?: RunStep) => Promise<void>,
  ): Promise<{
    cases: GeneratedCase[];
    caseIds: Map<number, GeneratedCase>;
    startedAtMs: number;
    horizonMs: number;
    steps: RunStep[];
    errors: RunError[];
  }> {
    const runSeed = `${config.seed}/${config.difficulty}/${config.batchSize}`;
    const anchorMs = SIM_ANCHOR_MS;
    const startedAtMs = anchorMs - WINDOW_MS;

    const population = buildPopulation({
      runSeed,
      runRef: runId,
      simRunId: runId,
      batchSize: config.batchSize,
      mix: config.mix,
      difficulty: config.difficulty,
      startedAtMs,
      arrivalWindowMs: ARRIVAL_WINDOW_MS,
    });

    const batchQueue = batchQueueOf(this.queue);
    await batchQueue.clear();
    this.collectedActions.clear();

    const caseIds = new Map<number, GeneratedCase>();
    const steps: RunStep[] = [];
    const errors: RunError[] = [];

    /**
     * One case failing must not take the batch with it.
     *
     * A timed-out transaction on case 97 says nothing about case 98, and losing
     * two hundred cases of evidence to it would be the worse failure by a wide
     * margin. The error is recorded rather than swallowed: the count reaches
     * the report, so a degraded run is visibly degraded instead of quietly
     * smaller. Past MAX_ERRORS the run stops, because at that point the
     * problem is not this case.
     */
    const guard = async (stage: string, caseId: number | null, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        const reason = (error as Error).message;
        errors.push({ caseId, stage, reason });
        this.logger.warn(`${stage} failed for case ${caseId ?? "?"}: ${reason}`);

        if (errors.length > MAX_ERRORS) {
          throw new Error(
            `Simulation abandoned after ${errors.length} case-level failures; the last was: ${reason}`,
          );
        }
      }
    };

    const frame: ClockFrame = { offsetMs: 0 };
    // Time stands still inside a tick. Everything due at a simulated instant is
    // worked *at* that instant, however many real seconds the work takes —
    // otherwise two cases due at 09:00 are gated against clocks a few hundred
    // milliseconds apart, one of them falls the wrong side of the quiet-hours
    // boundary, and the batch stops reproducing (B-35).
    const setSimTime = (offsetMs: number) => {
      frame.fixedMs = startedAtMs + offsetMs;
      frame.offsetMs = frame.fixedMs - Date.now();
    };

    await this.clock.runShifted(frame, async () => {
      setSimTime(0);
      this.registerHandler(batchQueue, caseIds, guard);

      await this.seedBackgroundTraffic(merchantId, runId, runSeed, population, startedAtMs);

      const arrivals = [...population].sort((a, b) => a.arrivalOffsetMs - b.arrivalOffsetMs);
      const reactions: PendingReaction[] = [];
      let nextArrival = 0;
      let lastScanMs = startedAtMs - 1;
      let lastMonitorMs = startedAtMs;
      let lastProgress = -1;

      for (;;) {
        const next = this.nextInstant(
          arrivals[nextArrival]?.arrivalOffsetMs,
          batchQueue.nextDueAt(),
          reactions[0]?.atMs,
          startedAtMs,
        );

        if (next === null || next > WINDOW_MS) {
          // Nothing is scheduled — but a message sent during the last tick may
          // not have been looked at yet, and a customer who was about to reply
          // is not the same thing as a batch that is finished. One last sweep,
          // and the loop continues only if it actually found somebody.
          const before = reactions.length;
          lastScanMs = await this.collectReactions(
            caseIds,
            reactions,
            lastScanMs,
            startedAtMs + WINDOW_MS,
          );
          if (reactions.length > before) continue;
          break;
        }

        setSimTime(next);
        const nowMs = startedAtMs + next;

        // Everything the agent sent up to this instant, collected once, at the
        // top of the tick.
        //
        // It used to be collected in the middle, between the tick's two drains,
        // which silently dropped every send the *second* drain made: with time
        // frozen, those rows carry this tick's timestamp, and the next tick
        // looks strictly after it. Customers who were messaged during the
        // post-approval drain therefore never replied and never paid — and
        // which sends landed there varied from run to run, so the batch stopped
        // reproducing as well (B-36).
        lastScanMs = await this.collectReactions(caseIds, reactions, lastScanMs, nowMs);
        await this.deliverReactions(reactions, nowMs, caseIds, guard);

        // Arrivals next: a case cannot be worked before it exists.
        const due: GeneratedCase[] = [];
        while (nextArrival < arrivals.length && arrivals[nextArrival].arrivalOffsetMs <= next) {
          due.push(arrivals[nextArrival]);
          nextArrival += 1;
        }
        // Monitor marks and arrivals interleave in time order. A mark evaluated
        // after a later arrival had opened an incident would close it into the
        // past — "recovered 10:15, detected 10:45" — and the next mark would
        // open a duplicate.
        const monitorUpTo = async (untilMs: number) => {
          for (let at = lastMonitorMs + MONITOR_STEP_MS; at <= untilMs; at += MONITOR_STEP_MS) {
            await guard("monitor", null, () =>
              this.detector.syncIncident(merchantId, new Date(at), runId),
            );
            lastMonitorMs = at;
          }
        };
        for (const generated of due) {
          await monitorUpTo(generated.event.occurredAt.getTime());
          await this.ingestBatch([generated], caseIds, reactions, startedAtMs + WINDOW_MS, guard);
        }
        await monitorUpTo(nowMs);

        await batchQueue.drain(nowMs, {
          concurrency: CONCURRENCY,
          maxJobs: MAX_JOBS_PER_DRAIN,
        });

        // The merchant is part of the loop, so the batch simulates one. Without
        // it every escalation is a dead end and the escalation block of the
        // report is a column of zeroes (see merchant-persona.ts).
        const decided = await this.decideApprovals(runId, merchantId, nowMs, caseIds, guard);

        // A release re-runs the gate and can send, so the queue is worked again.
        if (decided > 0) {
          await batchQueue.drain(nowMs, {
            concurrency: CONCURRENCY,
            maxJobs: MAX_JOBS_PER_DRAIN,
          });
        }

        const progress = Math.min(99, Math.round((next / WINDOW_MS) * 100));
        if (onProgress && progress > lastProgress) {
          lastProgress = progress;
          await onProgress(
            progress,
            this.narrate(steps, next / WINDOW_MS, caseIds.size, population.length),
          );
        }
      }

      // Everything left in the queue is scheduled beyond the horizon. Those
      // cases are genuinely unfinished, and the report says so rather than
      // draining them into a tidier number.
      const stranded = batchQueue.pending().length;
      if (stranded > 0) {
        this.logger.log(
          `${stranded} jobs were still scheduled past the ${WINDOW_MS / DAY_MS}-day horizon`,
        );
      }
    });

    return { cases: population, caseIds, startedAtMs, horizonMs: WINDOW_MS, steps, errors };
  }

  /* ---------------------------------------------------------------- */
  /* The batch's own worker                                            */
  /* ---------------------------------------------------------------- */

  /**
   * The batch drives the Executor itself rather than through `AgentWorker`.
   *
   * Not to change what the agent does — the calls below are the ones the worker
   * makes — but because two of them need an answer only the simulator has.
   * Whether a re-presentation captures depends on the customer's actual balance
   * and the *true* cause; whether a call is picked up depends on the persona.
   * Letting the adapters guess from a hash of the case id would make a wrong
   * diagnosis cost nothing, and an accuracy figure that costs nothing is not
   * worth reporting.
   */
  private registerHandler(
    queue: InlineActionQueue,
    caseIds: Map<number, GeneratedCase>,
    guard: Guard,
  ): void {
    queue.process((job: QueuedJob) => guard("job", job.caseId, () => this.runJob(job, caseIds)));
  }

  private async runJob(job: QueuedJob, caseIds: Map<number, GeneratedCase>): Promise<void> {
    {
      if (job.kind === "promise.checkin" && job.promiseId) {
        await this.executor.checkPromise(job.promiseId);
        return;
      }

      if (job.kind === "case.handover") {
        await this.executor.raiseHandover(job.caseId, job.reason);
        return;
      }

      if (job.kind === "approval.release" && job.approvalId) {
        await this.executor.releaseApproved(job.approvalId);
        return;
      }

      const generated = caseIds.get(job.caseId);
      if (!generated) {
        await this.executor.step(job.caseId, { expectAttempt: job.expectAttempt });
        return;
      }

      const contact = {
        channel: "RETRY" as const,
        attempt: (job.expectAttempt ?? 0) + 1,
        atMs: this.clock.nowMs(),
        openedAtMs: generated.event.occurredAt.getTime(),
        contactsSoFar: (job.expectAttempt ?? 0) + 1,
      };

      await this.executor.step(job.caseId, {
        expectAttempt: job.expectAttempt,
        captured: retryCaptures(generated.persona, contact),
        counterpart: voiceCounterpart(generated.persona, contact),
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Arrivals                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Arrivals are ingested one at a time, and this is the run's largest cost.
   *
   * Everything else in the batch overlaps freely, because cases are independent
   * conversations. Ingestion is not: opening a case records a failure against
   * the merchant's payment-health window and then asks the Detector whether the
   * gateway was degraded when it happened. That window is *shared*, and it is
   * read by the Diagnoser a few milliseconds later — so whether rule R-04 fires
   * for a given case depends on how many of its concurrent siblings recorded
   * their sample first. Run the same seed twice and a handful of cases get a
   * different root cause, a different playbook, and a different ending (B-37).
   *
   * That is not a bug in the Detector. Two payments failing in the same second
   * genuinely do see different windows, and a rolling health metric is supposed
   * to depend on what has been observed. It is a property a *reproducible*
   * batch has to pin down, and the only honest way to pin it is to fix an order
   * rather than to give the simulator a private path around the detector.
   */
  private async ingestBatch(
    due: GeneratedCase[],
    caseIds: Map<number, GeneratedCase>,
    reactions: PendingReaction[],
    horizonMs: number,
    guard: Guard,
  ): Promise<void> {
    for (const generated of due) {
      await guard("ingest", null, async () => {
        const outcome = await this.ingestion.ingest(generated.event);
        if (outcome.status !== "accepted") return;

        caseIds.set(outcome.caseId, generated);
        this.scheduleUnpromptedPayment(outcome.caseId, generated, reactions, horizonMs);
      });
    }
  }

  /**
   * The payment that arrives whether or not the agent does anything.
   *
   * `wouldSelfRecover` is the trait the baseline arm is built from: this
   * customer was going to pay on their own, `selfRecoverAfterHours` after the
   * case opened, and both counterfactuals credit it (`counterfactuals.ts`).
   * The executed arm did not — its payments came only from reactions to
   * contacts — so a customer nobody reached paid in the arms that never ran
   * and not in the one that did, and the agent was measured against a baseline
   * it could not match. On fourteen cases that made the uplift negative
   * (B-46, D-121). The instant is a property of the persona, so a rerun
   * schedules it identically; a case that was paid sooner declines the second
   * payment as a late reaction, like any other.
   */
  private scheduleUnpromptedPayment(
    caseId: number,
    generated: GeneratedCase,
    reactions: PendingReaction[],
    horizonMs: number,
  ): void {
    const atMs = unpromptedPaymentAt(
      generated.persona,
      generated.event.occurredAt.getTime(),
      horizonMs,
    );
    if (atMs === null) return;

    this.reactionSeq += 1;
    reactions.push({
      kind: "pay",
      atMs,
      note: "Paid unprompted — would have paid without being contacted",
      caseId,
      simIndex: generated.index,
      seq: this.reactionSeq,
    });
    reactions.sort((a, b) => a.atMs - b.atMs || a.simIndex - b.simIndex || a.seq - b.seq);
  }

  /**
   * Successful payments, so the degradation monitor has something to compare to.
   *
   * A merchant whose only recorded traffic is the failures TUGBOAT opened cases
   * for looks, to the detector, like a gateway that has never once worked. The
   * baseline would then be zero, no dip would ever be unusual, and the z-score
   * monitor the Detector exists for could not fire. These rows are the ordinary
   * business the batch is a slice of, with one deliberate dip on the final
   * afternoon of the arrival window — 14:00 to 19:00 IST — so that the 24 hours
   * the promoted batch's dashboard chart shows hold the incident the Detector
   * opened (D-142).
   */
  private async seedBackgroundTraffic(
    merchantId: string,
    runId: string,
    runSeed: string,
    population: GeneratedCase[],
    startedAtMs: number,
  ): Promise<void> {
    // Drawn from the seed, not the run id: the traffic decides when the
    // detector fires and which cases R-04 explains, so two runs of one seed
    // must draw the same outage (D-143).
    const rng = new SeededRng(`${runSeed}/traffic`);
    const samples: {
      merchantId: string;
      success: boolean;
      at: Date;
      simRunId: string;
    }[] = [];

    // Inside the arrival window, so the cases opened during it can be explained
    // by it, and on its last day, so the chart's window holds it. Arrivals start
    // at 09:00 IST (SIM_ANCHOR_MS); nineteen hours before they end is 14:00 IST
    // on the final day.
    const dipStart = ARRIVAL_WINDOW_MS - 19 * HOUR_MS;
    const dipEnd = dipStart + 5 * HOUR_MS;

    for (let hour = 0; hour * HOUR_MS < ARRIVAL_WINDOW_MS; hour += 1) {
      const offset = hour * HOUR_MS;
      const degraded = offset >= dipStart && offset < dipEnd;
      // Attempts do not stop during an outage; captures do.
      const count = BASE_TRAFFIC_PER_HOUR;

      for (let i = 0; i < count; i += 1) {
        samples.push({
          merchantId,
          success: rng.bool(degraded ? 0.58 : 0.965),
          at: new Date(startedAtMs + offset + rng.int(0, 59) * 60_000),
          simRunId: runId,
        });
      }
    }

    const written = await this.detector.recordOutcomes(samples);
    this.logger.log(
      `Seeded ${written} background payment samples across ${population.length} generated cases`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Customers                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Turns everything the agent sent since the last look into what customers do
   * about it.
   *
   * Read from the `actions` table rather than from the executor's return value
   * because that is the record of what actually left the building — an action
   * the gate deferred, or one that failed at the adapter, never reached anybody
   * and must not produce a reply.
   */
  private async collectReactions(
    caseIds: Map<number, GeneratedCase>,
    reactions: PendingReaction[],
    sinceMs: number,
    nowMs: number,
  ): Promise<number> {
    const sent = await this.prisma.action.findMany({
      where: {
        // By id rather than through the relation: `actions.caseId` is indexed
        // and the join is not, and this query runs on every busy hour of the
        // simulated timeline.
        caseId: { in: [...caseIds.keys()] },
        status: "EXECUTED",
        channel: { not: "RETRY" },
        // Inclusive at the bottom. Time stands still inside a tick (B-35), so a
        // send made during tick N is stamped with tick N's instant — which is
        // exactly the watermark tick N+1 scans from. A strict `gt` here
        // excluded every message the agent ever sent, and no customer replied
        // to anything for as long as the clock had been frozen (B-48). The
        // seen-set above keeps the inclusive bound from double-collecting.
        executedAt: { gte: new Date(sinceMs), lte: new Date(nowMs) },
      },
      select: {
        id: true,
        caseId: true,
        channel: true,
        attempt: true,
        executedAt: true,
        payload: true,
      },
      orderBy: { executedAt: "asc" },
    });

    for (const action of sent) {
      if (this.collectedActions.has(action.id)) continue;
      this.collectedActions.add(action.id);

      const generated = caseIds.get(action.caseId);
      if (!generated || !action.channel || !action.executedAt) continue;

      const concession = (action.payload as { concessionPaise?: number } | null)?.concessionPaise;

      const produced = reactTo(generated.persona, {
        channel: action.channel,
        attempt: action.attempt,
        atMs: action.executedAt.getTime(),
        openedAtMs: generated.event.occurredAt.getTime(),
        contactsSoFar: action.attempt,
        concessionPaise: concession,
      });

      for (const reaction of produced) {
        // The sequence disambiguates two reactions that land at the same
        // simulated instant: a persona whose payday is the binding constraint
        // produces the same `payAt` from two different contacts, and without
        // this the second one collides on the payment event id (B-33).
        this.reactionSeq += 1;
        reactions.push({
          ...reaction,
          caseId: action.caseId,
          simIndex: generated.index,
          seq: this.reactionSeq,
        });
      }
    }

    // Kept sorted so the loop can ask for the earliest without scanning.
    reactions.sort((a, b) => a.atMs - b.atMs || a.simIndex - b.simIndex || a.seq - b.seq);

    return nowMs;
  }

  private async deliverReactions(
    reactions: PendingReaction[],
    nowMs: number,
    caseIds: Map<number, GeneratedCase>,
    guard: Guard,
  ): Promise<number> {
    const due: PendingReaction[] = [];
    while (reactions.length > 0 && reactions[0].atMs <= nowMs) due.push(reactions.shift()!);

    // Grouped by case, and applied in order within a group. A reply and a
    // payment on one case both write to that case's event log, and two writers
    // racing for the same sequence number is a collision the retry can lose
    // under load (B-33). Different cases still overlap freely, which is where
    // the run gets its speed.
    const byCase = new Map<number, PendingReaction[]>();
    for (const reaction of due) {
      const group = byCase.get(reaction.caseId) ?? [];
      group.push(reaction);
      byCase.set(reaction.caseId, group);
    }

    const groups = [...byCase.values()];

    for (let start = 0; start < groups.length; start += CONCURRENCY) {
      const slice = groups.slice(start, start + CONCURRENCY);

      await Promise.all(
        slice.map((group) =>
          guard("reaction", group[0].caseId, async () => {
            for (const reaction of group) {
              const generated = caseIds.get(reaction.caseId);
              if (!generated) continue;

              try {
                if (reaction.kind === "reply") {
                  await this.inbound.handle({
                    caseId: reaction.caseId,
                    channel: reaction.channel,
                    text: reaction.text,
                    at: new Date(reaction.atMs),
                  });
                  continue;
                }

                await this.ingestion.recordPayment({
                  eventId: `simpay_${generated.event.eventId}_${reaction.seq}`,
                  caseId: reaction.caseId,
                  amountPaise: generated.event.amountPaise,
                  reference: `pay_sim${String(generated.index).padStart(5, "0")}`,
                  via: reaction.note,
                  at: new Date(reaction.atMs),
                });
              } catch (error) {
                // A customer reacting to a case that has already closed is
                // ordinary: they answer the morning after the deadline expired,
                // or pay while the halt was in flight. The reply is still
                // recorded and the transition simply declines. Anything else is
                // a real failure and goes to the guard to be counted.
                if (!isLateReaction(error)) throw error;

                this.logger.debug(
                  `Reaction on case ${reaction.caseId} arrived too late to apply: ${(error as Error).message}`,
                );
              }
            }
          }),
        ),
      );
    }

    return due.length;
  }

  /**
   * The merchant answers whatever has been waiting long enough.
   *
   * Decisions go through `ApprovalsService.approve` and `.reject` — the same
   * methods the Approvals page calls — so an approved action is released
   * through the queue and re-checked by the gate exactly as it would be for a
   * real click (D-67). Nothing here reaches into the case directly.
   */
  private async decideApprovals(
    runId: string,
    merchantId: string,
    nowMs: number,
    caseIds: Map<number, GeneratedCase>,
    guard: Guard,
  ): Promise<number> {
    const pending = await this.prisma.approval.findMany({
      where: { decision: null, case: { simRunId: runId } },
      select: { id: true, gate: true, caseId: true, requestedAt: true, atRiskPaise: true },
    });

    /**
     * Who this request is, in terms the seed decides.
     *
     * Never the approval's `id` or the case's: both are database identities,
     * fresh on every run, and seeding the merchant from one made the same
     * batch approve a different number of requests each time (B-41). The
     * generated index and the simulated instant are properties of the seed —
     * and the instant is what separates a second concession ask on one case
     * from the first, which a per-case key alone would collapse (D-89).
     */
    const keyOf = (row: { caseId: number; requestedAt: Date }): string =>
      `${caseIds.get(row.caseId)?.index ?? `db:${row.caseId}`}/${row.requestedAt.getTime()}`;

    // Value first, because that is the order a merchant triages in. The
    // tiebreakers are the generated index and the instant rather than the row
    // id, for the same reason: without a stable order two requests worth the
    // same amount are answered in whatever order the database returned them.
    const ordered = [...pending].sort(
      (a, b) =>
        b.atRiskPaise - a.atRiskPaise ||
        (caseIds.get(a.caseId)?.index ?? 0) - (caseIds.get(b.caseId)?.index ?? 0) ||
        a.requestedAt.getTime() - b.requestedAt.getTime(),
    );

    const ready = ordered.filter((row) => {
      const decision = decideAs(keyOf(row), row.gate);
      return row.requestedAt.getTime() + decision.afterMs <= nowMs;
    });

    for (const row of ready) {
      await guard("approval", row.caseId, async () => {
        const decision = decideAs(keyOf(row), row.gate);

        if (decision.kind === "approve") {
          await this.approvals.approve(merchantId, row.id, { by: SIMULATED_APPROVER });
          return;
        }

        await this.approvals.reject(merchantId, row.id, {
          by: decision.by,
          reason: decision.reason,
        });
      });
    }

    return ready.length;
  }

  /* ---------------------------------------------------------------- */
  /* Bookkeeping                                                       */
  /* ---------------------------------------------------------------- */

  private nextInstant(
    nextArrivalOffset: number | undefined,
    nextJobAtMs: number | null,
    nextReactionAtMs: number | undefined,
    startedAtMs: number,
  ): number | null {
    const candidates = [
      nextArrivalOffset,
      nextJobAtMs === null ? undefined : nextJobAtMs - startedAtMs,
      nextReactionAtMs === undefined ? undefined : nextReactionAtMs - startedAtMs,
    ].filter((value): value is number => value !== undefined);

    if (candidates.length === 0) return null;

    // Never step backwards: a job whose due time has already passed is due now.
    // Rounded up onto the grid so everything owed within the hour is worked
    // together rather than one visit at a time.
    const earliest = Math.max(0, Math.min(...candidates));
    return Math.ceil(earliest / TICK_GRID_MS) * TICK_GRID_MS;
  }

  /** The runner's own narration, in the shape the Simulation Lab replays. */
  private narrate(
    steps: RunStep[],
    fraction: number,
    opened: number,
    total: number,
  ): RunStep | undefined {
    const milestones: { at: number; step: RunStep }[] = [
      {
        at: 0.02,
        step: {
          at: 0.02,
          actor: "BOA",
          line: "Batch seeded",
          meta: `${total} cases · personas sealed from the agent`,
        },
      },
      {
        at: 0.12,
        step: {
          at: 0.12,
          actor: "BOA",
          line: "Detector opening cases",
          meta: `${opened} of ${total} arrived · degradation window inside the first day`,
        },
      },
      {
        at: 0.26,
        step: {
          at: 0.26,
          actor: "POLICY",
          line: "Quiet hours deferring",
          meta: "21:00–09:00 IST · contacts rescheduled to 09:00",
        },
      },
      {
        at: 0.4,
        step: {
          at: 0.4,
          actor: "BOA",
          line: "Diagnosis · rules first, model on the residue",
          meta: "Unmapped reason codes go to the model; the rest never leave the table",
        },
      },
      {
        at: 0.54,
        step: {
          at: 0.54,
          actor: "RECOVERY",
          line: "Silent retries landing",
          meta: "Gateway recovered · payments captured without a message",
        },
      },
      {
        at: 0.68,
        step: {
          at: 0.68,
          actor: "POLICY",
          line: "Opt-out halts",
          meta: "STOP received · every channel closed for those customers",
        },
      },
      {
        at: 0.82,
        step: {
          at: 0.82,
          actor: "POLICY",
          line: "Attempt caps closing cases",
          meta: "EXHAUSTED with the reason written to the ledger",
        },
      },
      {
        at: 0.94,
        step: {
          at: 0.94,
          actor: "RECOVERY",
          line: "Promises settling",
          meta: "Committed dates honoured · follow-ups collected",
        },
      },
    ];

    const next = milestones.find(
      (row) => fraction >= row.at && !steps.some((s) => s.at === row.at),
    );
    if (!next) return undefined;

    steps.push(next.step);
    return next.step;
  }
}

type Guard = (stage: string, caseId: number | null, work: () => Promise<unknown>) => Promise<void>;

/**
 * True for the two outcomes a late customer reaction legitimately produces.
 *
 * Narrow on purpose. A blanket catch here would hide a timed-out transaction
 * behind the same silence as a customer replying to a closed case, and the run
 * would report a tidy batch that had quietly lost half its payments.
 */
function isLateReaction(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  return message.includes("Illegal case transition") || message.includes("not found");
}

export const BATCH_WINDOW_MS = WINDOW_MS;
export const BATCH_ARRIVAL_WINDOW_MS = ARRIVAL_WINDOW_MS;
