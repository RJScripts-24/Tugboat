import { Logger } from "@nestjs/common";
import { Queue, Worker, type JobsOptions } from "bullmq";

import type {
  ActionQueue,
  EnqueueOptions,
  JobHandler,
  QueuedJob,
} from "./action-queue.interface";

export const QUEUE_NAME = "tugboat-actions";

/** States in which a job is still ahead of the worker. */
const PENDING_STATES = new Set(["waiting", "delayed", "prioritized", "active", "waiting-children"]);

/**
 * How many times a single command is retried while Redis is unreachable
 * before the producer gives up.
 *
 * ioredis's default is twenty, spaced out to several minutes in total, and a
 * webhook handler that waits several minutes to schedule a step is a webhook
 * Razorpay has long since given up on. Failing in a few seconds turns a broken
 * broker into a 500 the provider retries and the reconciler repairs (D-131),
 * instead of a request that hangs.
 */
const PRODUCER_RETRIES = 3;
const PING_TIMEOUT_MS = 2_000;

/**
 * How long one producer operation — add, look up, remove — may wait for the
 * broker before it is treated as failed.
 *
 * ioredis retries a command across reconnection attempts, and the reconnection
 * waits grow: the outage experiment measured a webhook blocked for 52 seconds
 * before the third retry gave up (B-57). A provider does not wait that long
 * for a 2xx. Five seconds is longer than any healthy round trip and short
 * enough that the request fails while the caller is still listening; the
 * case is already committed by then, and the reconciler restores its job.
 */
const OP_TIMEOUT_MS = 5_000;

/** Reconnect quickly and keep trying: a broker that is back should be used within seconds. */
function retryStrategy(times: number): number {
  return Math.min(times * 500, 5_000);
}

/**
 * How often the worker is checked, and how long it may sit idle with work
 * waiting before it is replaced.
 *
 * After a broker outage the producer side recovers on its own and the worker
 * does not: its fetch loop is still running, the connection is back, and it
 * never takes another job (B-58). Whatever the cause inside the library, the
 * observable fact is "jobs waiting, nothing active, nothing has happened for a
 * minute", and the cure that works is a new worker on a new connection. Sixty
 * seconds is longer than any job takes to start and shorter than a demo.
 */
const SUPERVISE_MS = 30_000;
const IDLE_WITH_WORK_MS = 60_000;

/**
 * The agent's job ids on the wire.
 *
 * BullMQ reserves `:` inside custom ids (it is the separator of its own key
 * scheme) and rejects `case:1001:step:2` outright — a rule its integration
 * test never met because every id it used happened to have exactly three
 * parts, the one shape BullMQ still tolerates for old repeatable jobs (B-55).
 * The agent keeps its ids; this adapter spells them with `.` for Redis and
 * reads them back the same way, so `has` and `cancel` see the id the executor
 * gave.
 */
function wireId(jobId: string): string {
  return jobId.replaceAll(":", ".");
}

/**
 * BullMQ over Redis.
 *
 * Redis is pinned to `noeviction` (Stage 0) because every key in here is a
 * future recovery action: under the default policy, memory pressure would
 * silently drop a "re-present this mandate on day 3" job with no error
 * anywhere — a customer never contacted, on a case the dashboard still shows as
 * scheduled.
 *
 * Job ids are the agent's, and they are reused: a rung that is deferred by the
 * gate cancels its own id and schedules it again at the real time. BullMQ
 * refuses to add an id it already holds, and refuses to remove one that is
 * locked by the worker running it — which is exactly the job doing the
 * rescheduling. So a job that re-enqueues itself is held here until it has
 * finished, then removed and added again with the new delay (B-52).
 */
export class BullActionQueue implements ActionQueue {
  readonly kind = "bullmq" as const;

  private readonly logger = new Logger(BullActionQueue.name);
  private readonly queue: Queue<QueuedJob>;
  private worker: Worker<QueuedJob> | null = null;
  /** Ids this worker is processing right now. */
  private readonly active = new Set<string>();
  /** Re-schedules requested by a job for its own id, applied once it completes. */
  private readonly deferred = new Map<string, { job: QueuedJob; options: EnqueueOptions }>();
  private handler: JobHandler | null = null;
  private supervisor: NodeJS.Timeout | null = null;
  /** The last moment the worker took or finished a job. */
  private lastProgressAt = Date.now();

  constructor(
    private readonly connectionUrl: string,
    private readonly queueName: string = QUEUE_NAME,
  ) {
    this.queue = new Queue<QueuedJob>(queueName, {
      connection: { url: connectionUrl, maxRetriesPerRequest: PRODUCER_RETRIES, retryStrategy },
      defaultJobOptions: {
        // Keep a short tail of finished jobs: enough to inspect after a demo,
        // not enough to grow without bound on a free-tier Redis.
        removeOnComplete: 200,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
      },
    });

    // A connection error with nobody listening is an unhandled 'error' event,
    // and an unhandled 'error' event ends the process. Redis going away must
    // cost the queue, not the API.
    this.queue.on("error", (error) => {
      this.logger.error(`Queue connection: ${error.message}`);
    });
  }

  async enqueue(job: QueuedJob, options: EnqueueOptions = {}): Promise<void> {
    const state = await bounded(this.queue.getJobState(wireId(job.jobId)));

    if (state === "active") {
      if (this.active.has(job.jobId)) {
        this.deferred.set(job.jobId, { job, options });
        return;
      }
      // Another worker holds it; the same wait is already being worked.
      return;
    }

    if (state === "completed" || state === "failed") {
      // A finished job keeps its id in the tail. The tail is for reading, not
      // for blocking the next schedule under the same name.
      const finished = await bounded(this.queue.getJob(wireId(job.jobId)));
      if (finished) await bounded(finished.remove());
    }

    await this.add(job, options);
  }

  async cancel(jobId: string): Promise<void> {
    this.deferred.delete(jobId);

    const job = await bounded(this.queue.getJob(wireId(jobId)));
    if (!job) return;

    // The job cancelling itself is still locked; it ends when its handler
    // returns, and nothing about it needs removing before then.
    if ((await bounded(job.getState())) === "active") return;

    await bounded(job.remove());
  }

  process(handler: JobHandler): void {
    if (this.worker) return;
    this.handler = handler;
    this.worker = this.startWorker(handler);

    if (!this.supervisor) {
      this.supervisor = setInterval(() => {
        void this.supervise().catch((error) => {
          this.logger.error(`Worker supervision failed: ${(error as Error).message}`);
        });
      }, SUPERVISE_MS);
      this.supervisor.unref();
    }
  }

  private startWorker(handler: JobHandler): Worker<QueuedJob> {
    const worker = new Worker<QueuedJob>(
      this.queueName,
      async (job) => {
        const id = job.data.jobId;
        this.active.add(id);
        this.lastProgressAt = Date.now();
        try {
          await handler(job.data);
        } finally {
          this.active.delete(id);
          this.lastProgressAt = Date.now();
        }
      },
      {
        connection: { url: this.connectionUrl, retryStrategy },
        // One case at a time per worker. The gate and the idempotency key make
        // concurrent work safe, but serial execution keeps the demo's timeline
        // readable and the free-tier Redis unbothered.
        concurrency: 4,
      },
    );

    worker.on("completed", (job) => {
      void this.flushDeferred(job.data.jobId);
    });

    worker.on("failed", (job, error) => {
      // A failed job is retried by BullMQ under its own id; a re-schedule it
      // asked for before failing would race that retry.
      if (job) this.deferred.delete(job.data.jobId);
      this.logger.error(`Job ${job?.data.jobId ?? "?"} failed: ${error.message}`);
    });

    worker.on("error", (error) => {
      this.logger.error(`Worker connection: ${error.message}`);
    });

    return worker;
  }

  /**
   * Replaces a worker that has stopped taking work.
   *
   * Two shapes of "stopped": the fetch loop has exited (`isRunning` is false),
   * which BullMQ does not restart on its own; and the loop is alive but has
   * taken nothing while jobs sit waiting, which is what a broker outage leaves
   * behind (B-58). Both end the same way — the old worker is closed with a
   * bound, because a worker holding a dead connection can refuse to close, and
   * a new one is started on a fresh connection.
   */
  private async supervise(): Promise<void> {
    const worker = this.worker;
    if (!worker || !this.handler) return;

    const idleFor = Date.now() - this.lastProgressAt;
    let reason: string | null = null;

    if (!worker.isRunning()) {
      reason = "its fetch loop has exited";
    } else if (this.active.size === 0 && idleFor > IDLE_WITH_WORK_MS) {
      const waiting = await bounded(this.queue.getJobCountByTypes("waiting", "prioritized")).catch(
        () => 0,
      );
      if (waiting > 0) {
        reason = `${waiting} job(s) have been waiting with nothing taken for ${Math.round(idleFor / 1000)}s`;
      }
    }

    if (!reason) return;

    this.logger.warn(`Replacing the worker: ${reason}`);
    this.worker = null;
    try {
      await withTimeout(worker.close(true), OP_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(`The old worker did not close cleanly: ${(error as Error).message}`);
    }
    this.lastProgressAt = Date.now();
    this.worker = this.startWorker(this.handler);
  }

  async has(jobId: string): Promise<boolean> {
    if (this.deferred.has(jobId)) return true;

    const state = await bounded(this.queue.getJobState(wireId(jobId)));
    return PENDING_STATES.has(state);
  }

  async ping(): Promise<boolean> {
    try {
      // A real command over the queue's own connection, so the answer is
      // about the broker this queue would actually schedule through.
      await withTimeout(this.queue.getJobCountByTypes("waiting"), PING_TIMEOUT_MS);
      return true;
    } catch (error) {
      this.logger.error(`Redis ping failed: ${(error as Error).message}`);
      return false;
    }
  }

  async clear(): Promise<void> {
    this.deferred.clear();
    await this.queue.obliterate({ force: true });
  }

  async close(): Promise<void> {
    if (this.supervisor) clearInterval(this.supervisor);
    this.supervisor = null;
    await this.worker?.close();
    await this.queue.close();
  }

  private async add(job: QueuedJob, options: EnqueueOptions): Promise<void> {
    const jobOptions: JobsOptions = {
      // BullMQ refuses a second job with an id it already holds, which is
      // exactly the de-duplication this needs — the same wait, scheduled twice
      // by two workers, must produce one job.
      jobId: wireId(job.jobId),
      delay: options.delayMs ?? 0,
    };

    await bounded(this.queue.add(job.kind, job, jobOptions));
  }

  private async flushDeferred(jobId: string): Promise<void> {
    const pending = this.deferred.get(jobId);
    if (!pending) return;
    this.deferred.delete(jobId);

    try {
      await (await this.queue.getJob(wireId(jobId)))?.remove();
      await this.add(pending.job, pending.options);
    } catch (error) {
      this.logger.error(`Could not re-schedule ${jobId} after it completed: ${(error as Error).message}`);
    }
  }
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  return withTimeout(promise, OP_TIMEOUT_MS);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
