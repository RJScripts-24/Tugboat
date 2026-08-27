import "dotenv/config";

import { randomUUID } from "node:crypto";

import { BullActionQueue } from "../src/queue/bull-action-queue";
import type { QueuedJob } from "../src/queue/action-queue.interface";

/**
 * INTEGRATION SUITE — needs the real Redis (`npm run test:int`).
 *
 * The agent loop is proven against the deterministic queue, because a batch
 * cannot wait three real days for a mandate retry. This suite exists so that
 * choice never becomes an excuse: the production scheduler is BullMQ over
 * Redis, and these tests run against it.
 */
const describeIfRedis = process.env.REDIS_URL ? describe : describe.skip;

describeIfRedis("BullMQ scheduling (integration)", () => {
  const RUN = randomUUID().slice(0, 8);
  let queue: BullActionQueue;

  function job(suffix: string, overrides: Partial<QueuedJob> = {}): QueuedJob {
    return {
      kind: "case.step",
      caseId: 999_000,
      jobId: `int:${RUN}:${suffix}`,
      reason: "queue integration test",
      ...overrides,
    };
  }

  /** Waits for a condition without a fixed sleep, so the test is not a race. */
  async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("condition was not met before the timeout");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * One worker for the suite, because `process` deliberately registers only
   * once — a second worker per queue instance would double-consume.
   */
  const seen: QueuedJob[] = [];

  beforeAll(async () => {
    // A queue of its own. The API's worker, when one is running against the
    // same Redis, consumes anything placed on the production queue name — and
    // `clear` here would empty that queue under it (B-51).
    queue = new BullActionQueue(process.env.REDIS_URL as string, `tugboat-actions-int-${RUN}`);
    // Redis outlives the process. Anything a previous run left scheduled would
    // fire into this one and be counted as ours.
    await queue.clear();
    queue.process(async (entry) => {
      seen.push(entry);
    });
  });

  afterAll(async () => {
    await queue.clear();
    await queue.close();
  });

  it("round-trips a job through Redis to a worker", async () => {
    await queue.enqueue(job("roundtrip"));
    await until(() => seen.some((entry) => entry.jobId === `int:${RUN}:roundtrip`));

    const delivered = seen.find((entry) => entry.jobId === `int:${RUN}:roundtrip`);
    expect(delivered?.caseId).toBe(999_000);
    expect(delivered?.reason).toBe("queue integration test");
  });

  it("carries the attempt guard across the wire", async () => {
    await queue.enqueue(job("guard", { expectAttempt: 2 }));
    await until(() => seen.some((entry) => entry.jobId === `int:${RUN}:guard`));

    // The whole point of B-15: a redelivered job must still know which rung it
    // was scheduled for, and that only holds if the field survives serialisation.
    expect(seen.find((entry) => entry.jobId === `int:${RUN}:guard`)?.expectAttempt).toBe(2);
  });

  it("refuses a duplicate job id, which is how a repeat schedule is de-duplicated", async () => {
    const delayed = job("dedupe");
    await queue.enqueue(delayed, { delayMs: 60_000 });
    await queue.enqueue(delayed, { delayMs: 60_000 });

    // Neither has run yet, so both are still holding the same id: Redis kept one.
    await queue.cancel(delayed.jobId);
    expect(seen.filter((entry) => entry.jobId === delayed.jobId)).toHaveLength(0);
  });

  it("answers a ping from the broker it is actually connected to", async () => {
    expect(await queue.ping()).toBe(true);
  });

  it("knows which jobs are still ahead of the worker", async () => {
    const waiting = job("has-delayed");
    await queue.enqueue(waiting, { delayMs: 60_000 });

    expect(await queue.has(waiting.jobId)).toBe(true);
    expect(await queue.has(`int:${RUN}:never-scheduled`)).toBe(false);

    await queue.cancel(waiting.jobId);
    expect(await queue.has(waiting.jobId)).toBe(false);
  });

  it("lets a job cancel and re-schedule its own id from inside its handler, the way a deferred rung does", async () => {
    // The executor's defer path: the running job is the guess, the gate names
    // the real time, and the same id is cancelled and scheduled again from
    // inside the handler that is processing it (executor.service.ts, defer).
    const rung = job("defer-self", { caseId: 999_001 });
    const rescheduler = new BullActionQueue(process.env.REDIS_URL as string, `tugboat-actions-int-${RUN}-defer`);
    const runs: number[] = [];
    let handlerError: Error | null = null;

    rescheduler.process(async (entry) => {
      runs.push(Date.now());
      if (runs.length > 1) return;
      try {
        await rescheduler.cancel(entry.jobId);
        await rescheduler.enqueue(entry, { delayMs: 300 });
      } catch (error) {
        handlerError = error as Error;
        throw error;
      }
    });

    try {
      await rescheduler.enqueue(rung);
      await until(() => runs.length === 2, 20_000);

      expect(handlerError).toBeNull();
      expect(runs[1] - runs[0]).toBeGreaterThanOrEqual(250);
    } finally {
      await rescheduler.clear();
      await rescheduler.close();
    }
  });

  it("schedules an id again after the job that held it has completed", async () => {
    const again = job("after-completion", { caseId: 999_002 });
    await queue.enqueue(again);
    await until(() => seen.filter((entry) => entry.jobId === again.jobId).length === 1);

    // The finished job still sits in the completed tail under this id. A
    // second schedule must run, not vanish into "already exists".
    await queue.enqueue(again);
    await until(() => seen.filter((entry) => entry.jobId === again.jobId).length === 2);
  });

  it("accepts the executor's real id shape, which BullMQ would refuse on the wire (B-55)", async () => {
    // Four colon-separated parts: exactly what `case:<id>:step:<n>` is, and
    // exactly what BullMQ rejects as a custom id. The adapter spells it
    // differently for Redis and answers `has` by the id the executor gave.
    const rung = job("shape", { jobId: `case:999003:step:${RUN}`, caseId: 999_003 });
    await queue.enqueue(rung, { delayMs: 60_000 });

    expect(await queue.has(rung.jobId)).toBe(true);
    await queue.cancel(rung.jobId);
    expect(await queue.has(rung.jobId)).toBe(false);
  });

  it("holds a delayed job and lets it be cancelled before it fires", async () => {
    const scheduled = job("cancelme");
    await queue.enqueue(scheduled, { delayMs: 30_000 });
    await queue.cancel(scheduled.jobId);

    // A halted case must leave nothing behind in the queue.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(seen.filter((entry) => entry.jobId === scheduled.jobId)).toHaveLength(0);
  });
});
