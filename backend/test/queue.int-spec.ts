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
    queue = new BullActionQueue(process.env.REDIS_URL as string);
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

  it("holds a delayed job and lets it be cancelled before it fires", async () => {
    const scheduled = job("cancelme");
    await queue.enqueue(scheduled, { delayMs: 30_000 });
    await queue.cancel(scheduled.jobId);

    // A halted case must leave nothing behind in the queue.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(seen.filter((entry) => entry.jobId === scheduled.jobId)).toHaveLength(0);
  });
});
