import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";

import { ACTION_QUEUE, type ActionQueue, type QueuedJob } from "../queue/action-queue.interface";
import { ExecutorService } from "./executor.service";

/**
 * The one place queued work becomes agent work.
 *
 * The queue knows how to hold a job until it is due; it knows nothing about
 * cases. This registers the handler at boot, which is also why the queue module
 * does not depend on the agent module — the dependency points one way, and the
 * handler is injected rather than imported.
 *
 * Every job is a no-op if the case has moved on: a halted case skips, a
 * recovered case skips, an already-sent action skips on its idempotency key.
 * That is what makes a redelivered or replayed job safe.
 */
@Injectable()
export class AgentWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentWorker.name);

  constructor(
    private readonly executor: ExecutorService,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
  ) {}

  onApplicationBootstrap(): void {
    this.queue.process((job) => this.handle(job));
    this.logger.log(`Listening for agent work on the ${this.queue.kind} queue`);
  }

  async handle(job: QueuedJob): Promise<void> {
    try {
      const outcome =
        job.kind === "promise.checkin" && job.promiseId
          ? await this.executor.checkPromise(job.promiseId)
          : await this.executor.step(job.caseId, { expectAttempt: job.expectAttempt });

      this.logger.log(`${job.jobId} -> ${outcome.kind} (${job.reason})`);
    } catch (error) {
      // Rethrown so BullMQ retries with backoff; the inline queue surfaces it
      // to the caller. Either way the failure is loud rather than swallowed.
      this.logger.error(`${job.jobId} threw: ${(error as Error).message}`);
      throw error;
    }
  }
}
