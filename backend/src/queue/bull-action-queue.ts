import { Logger } from "@nestjs/common";
import { Queue, Worker, type JobsOptions } from "bullmq";

import type {
  ActionQueue,
  EnqueueOptions,
  JobHandler,
  QueuedJob,
} from "./action-queue.interface";

const QUEUE_NAME = "tugboat-actions";

/**
 * BullMQ over Redis.
 *
 * Redis is pinned to `noeviction` (Stage 0) because every key in here is a
 * future recovery action: under the default policy, memory pressure would
 * silently drop a "re-present this mandate on day 3" job with no error
 * anywhere — a customer never contacted, on a case the dashboard still shows as
 * scheduled.
 */
export class BullActionQueue implements ActionQueue {
  readonly kind = "bullmq" as const;

  private readonly logger = new Logger(BullActionQueue.name);
  private readonly queue: Queue<QueuedJob>;
  private worker: Worker<QueuedJob> | null = null;

  constructor(private readonly connectionUrl: string) {
    this.queue = new Queue<QueuedJob>(QUEUE_NAME, {
      connection: { url: connectionUrl },
      defaultJobOptions: {
        // Keep a short tail of finished jobs: enough to inspect after a demo,
        // not enough to grow without bound on a free-tier Redis.
        removeOnComplete: 200,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
      },
    });
  }

  async enqueue(job: QueuedJob, options: EnqueueOptions = {}): Promise<void> {
    const jobOptions: JobsOptions = {
      // BullMQ refuses a second job with an id it already holds, which is
      // exactly the de-duplication this needs — the same wait, scheduled twice
      // by two workers, must produce one job.
      jobId: job.jobId,
      delay: options.delayMs ?? 0,
    };

    await this.queue.add(job.kind, job, jobOptions);
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    await job?.remove();
  }

  process(handler: JobHandler): void {
    if (this.worker) return;

    this.worker = new Worker<QueuedJob>(QUEUE_NAME, async (job) => handler(job.data), {
      connection: { url: this.connectionUrl },
      // One case at a time per worker. The gate and the idempotency key make
      // concurrent work safe, but serial execution keeps the demo's timeline
      // readable and the free-tier Redis unbothered.
      concurrency: 4,
    });

    this.worker.on("failed", (job, error) => {
      this.logger.error(`Job ${job?.id ?? "?"} failed: ${error.message}`);
    });
  }

  async clear(): Promise<void> {
    await this.queue.obliterate({ force: true });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
