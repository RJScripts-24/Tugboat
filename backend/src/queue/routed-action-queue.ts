import type { ClockService } from "../common/clock.service";
import type {
  ActionQueue,
  EnqueueOptions,
  JobHandler,
  QueuedJob,
} from "./action-queue.interface";
import { InlineActionQueue } from "./inline-action-queue";

/**
 * Two queues behind one token: the running system's, and the batch's.
 *
 * A simulation run moves the agent's clock across ten simulated days in a few
 * seconds. Its waits are real waits — a 20-hour cool-down, a three-day mandate
 * spacing — and handing those to Redis would mean a batch that finishes in
 * August 2036. So work started inside a shifted clock goes to a deterministic
 * in-memory queue the runner drains itself, and everything else goes to the
 * queue this deployment actually configured.
 *
 * The split is by clock rather than by a flag on the job, which is what keeps
 * the Executor ignorant of the simulator: it enqueues the same way it always
 * does, and the routing is a property of the context the call arrived in.
 */
export class RoutedActionQueue implements ActionQueue {
  readonly kind: "bullmq" | "inline";

  constructor(
    private readonly live: ActionQueue,
    readonly batch: InlineActionQueue,
    private readonly clock: ClockService,
  ) {
    this.kind = live.kind;
  }

  private get target(): ActionQueue {
    return this.clock.shifted ? this.batch : this.live;
  }

  async enqueue(job: QueuedJob, options?: EnqueueOptions): Promise<void> {
    await this.target.enqueue(job, options);
  }

  async cancel(jobId: string): Promise<void> {
    await this.target.cancel(jobId);
  }

  async clear(): Promise<void> {
    await this.target.clear();
  }

  /** Registered on both, because a handler is a property of the app, not of a run. */
  process(handler: JobHandler): void {
    this.live.process(handler);
    this.batch.process(handler);
  }

  async has(jobId: string): Promise<boolean> {
    return this.target.has(jobId);
  }

  /** The broker's reachability is a fact about the deployment, never about a run. */
  ping(): Promise<boolean> {
    return this.live.ping();
  }

  async close(): Promise<void> {
    await this.batch.close();
    await this.live.close();
  }
}

/**
 * The in-memory queue a batch run drains.
 *
 * Accepts a bare `InlineActionQueue` too, so a test that overrides
 * `ACTION_QUEUE` with one keeps working without knowing this type exists.
 */
export function batchQueueOf(queue: ActionQueue): InlineActionQueue {
  if (queue instanceof RoutedActionQueue) return queue.batch;
  if (queue instanceof InlineActionQueue) return queue;

  throw new Error(
    `A simulation run needs a drainable queue; ACTION_QUEUE is a ${queue.kind} queue that cannot be advanced by hand`,
  );
}
