import { Logger } from "@nestjs/common";

import type {
  ActionQueue,
  EnqueueOptions,
  JobHandler,
  QueuedJob,
} from "./action-queue.interface";

type Scheduled = { job: QueuedJob; dueAt: number };

/**
 * A queue that holds jobs until it is told to run them.
 *
 * Nothing fires on a timer, which is the whole point: a test can enqueue a
 * three-day mandate re-presentation and drain it in the same millisecond, and
 * the Stage 8 batch can advance a simulated clock rather than waiting. The
 * ordering is by due time then insertion, so the same seed produces the same
 * sequence of work — a real queue makes no such promise, and the evidence
 * report's reproducibility depends on it.
 */
export class InlineActionQueue implements ActionQueue {
  readonly kind = "inline" as const;

  private readonly logger = new Logger(InlineActionQueue.name);
  private readonly jobs = new Map<string, Scheduled>();
  private handler: JobHandler | null = null;
  private sequence = 0;
  private readonly order = new Map<string, number>();

  /**
   * Whose clock a delay is measured against.
   *
   * A due time and the drain that releases it have to be read from one clock or
   * the other, never one each: the Stage 8 batch schedules a 20-hour cool-down
   * on the agent's shifted clock and then drains at a shifted instant, and a
   * queue holding wall-clock due times would never let a single one of them go.
   */
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async enqueue(job: QueuedJob, options: EnqueueOptions = {}): Promise<void> {
    // Same job id means the same wait, already scheduled. Re-enqueueing it
    // would double-fire the step it guards.
    if (this.jobs.has(job.jobId)) {
      this.logger.debug(`Job ${job.jobId} already scheduled; ignoring duplicate`);
      return;
    }

    const delayMs = options.delayMs ?? 0;

    this.sequence += 1;
    this.order.set(job.jobId, this.sequence);
    // Undelayed work is due at any drain, not at "the clock when it was
    // queued" — otherwise a handler that schedules immediate follow-up work
    // sees it fall a millisecond outside the drain it was created in.
    this.jobs.set(job.jobId, { job, dueAt: delayMs > 0 ? this.nowMs() + delayMs : 0 });
  }

  async cancel(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    this.order.delete(jobId);
  }

  process(handler: JobHandler): void {
    this.handler = handler;
  }

  async has(jobId: string): Promise<boolean> {
    return this.jobs.has(jobId);
  }

  /** In memory, so reachable by construction. */
  async ping(): Promise<boolean> {
    return true;
  }

  async clear(): Promise<void> {
    this.jobs.clear();
    this.order.clear();
  }

  async close(): Promise<void> {
    await this.clear();
  }

  /**
   * Every job due at or before `now`, run in schedule order.
   *
   * Work a handler schedules during the drain runs too, if it is also due —
   * which is what lets a whole case play out in one call. `maxJobs` is the
   * runaway guard that makes that safe: a step that keeps scheduling due work
   * would otherwise spin forever, and a batch runner needs the loop to stop
   * loudly rather than hang.
   */
  async drain(
    now: number = this.nowMs(),
    options: { maxJobs?: number; concurrency?: number } = {},
  ): Promise<number> {
    if (!this.handler) throw new Error("InlineActionQueue has no handler registered");

    const maxJobs = options.maxJobs ?? 1000;
    // Serial by default, because that is what makes a test's expectations
    // readable. A batch run raises it: two hundred cases waiting on the same
    // simulated instant are two hundred independent conversations, each already
    // safe against the others through the gate and the idempotency key, and
    // running them one at a time spends the whole run waiting on network.
    const concurrency = Math.max(1, options.concurrency ?? 1);
    let ran = 0;

    for (;;) {
      const due = [...this.jobs.values()]
        .filter((entry) => entry.dueAt <= now)
        .sort((a, b) => (this.order.get(a.job.jobId) ?? 0) - (this.order.get(b.job.jobId) ?? 0));

      if (due.length === 0) return ran;

      if (ran + due.length > maxJobs) {
        throw new Error(
          `InlineActionQueue drained ${ran} jobs without settling — the handler is scheduling work as fast as it is consumed`,
        );
      }

      // Claimed before any handler runs, so a job a handler re-enqueues under
      // the same id is a new wait rather than one this pass swallows.
      for (const entry of due) await this.cancel(entry.job.jobId);

      for (let start = 0; start < due.length; start += concurrency) {
        const slice = due.slice(start, start + concurrency);
        await Promise.all(slice.map((entry) => this.handler!(entry.job)));
        ran += slice.length;
      }
    }
  }

  /** The earliest instant at which anything is due, on this queue's own clock. */
  nextDueAt(): number | null {
    let earliest: number | null = null;
    for (const entry of this.jobs.values()) {
      if (earliest === null || entry.dueAt < earliest) earliest = entry.dueAt;
    }
    return earliest;
  }

  /** What is still waiting, for assertions and for the simulator's clock. */
  pending(): QueuedJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => a.dueAt - b.dueAt)
      .map((entry) => entry.job);
  }

  dueAt(jobId: string): number | null {
    return this.jobs.get(jobId)?.dueAt ?? null;
  }
}
