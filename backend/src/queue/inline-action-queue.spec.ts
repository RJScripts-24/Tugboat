import type { QueuedJob } from "./action-queue.interface";
import { InlineActionQueue } from "./inline-action-queue";

function job(overrides: Partial<QueuedJob> = {}): QueuedJob {
  return { kind: "case.step", caseId: 1001, jobId: "case:1001:step:0", reason: "test", ...overrides };
}

describe("the deterministic queue", () => {
  let queue: InlineActionQueue;
  let ran: string[];

  beforeEach(() => {
    queue = new InlineActionQueue();
    ran = [];
    queue.process(async (entry) => {
      ran.push(entry.jobId);
    });
  });

  it("runs nothing until it is drained — no timers anywhere", async () => {
    await queue.enqueue(job());
    expect(ran).toEqual([]);

    await queue.drain();
    expect(ran).toEqual(["case:1001:step:0"]);
  });

  it("holds a delayed job back until its time arrives", async () => {
    await queue.enqueue(job({ jobId: "later" }), { delayMs: 20 * 60_000 });

    // Read the due time from the queue rather than recomputing it from a clock
    // sampled a moment earlier — that difference is exactly how a test like
    // this becomes intermittently red.
    const dueAt = queue.dueAt("later")!;

    expect(await queue.drain(dueAt - 1)).toBe(0);
    expect(queue.pending().map((entry) => entry.jobId)).toEqual(["later"]);

    // A simulated clock, not a real wait — which is the entire point of this
    // implementation: a three-day mandate spacing cannot be tested in real time.
    expect(await queue.drain(dueAt)).toBe(1);
    expect(ran).toEqual(["later"]);
  });

  it("stops loudly when a handler schedules work as fast as it is consumed", async () => {
    // A runaway loop must not hang a batch run; Stage 8 relies on this bound.
    queue.process(async () => {
      await queue.enqueue(job({ jobId: `spin-${ran.length}` }));
      ran.push("spin");
    });

    await queue.enqueue(job({ jobId: "spin-start" }));
    await expect(queue.drain(undefined, { maxJobs: 25 })).rejects.toThrow("without settling");
  });

  it("refuses a second job with an id it already holds", async () => {
    await queue.enqueue(job({ jobId: "same" }));
    await queue.enqueue(job({ jobId: "same" }));

    await queue.drain();
    expect(ran).toEqual(["same"]);
  });

  it("drops a cancelled job", async () => {
    await queue.enqueue(job({ jobId: "doomed" }));
    await queue.cancel("doomed");

    await queue.drain();
    expect(ran).toEqual([]);
  });

  it("cancelling something that was never scheduled is a no-op", async () => {
    await expect(queue.cancel("never-existed")).resolves.toBeUndefined();
  });

  it("runs work a handler schedules during the same drain", async () => {
    queue.process(async (entry) => {
      ran.push(entry.jobId);
      if (entry.jobId === "first") await queue.enqueue(job({ jobId: "second" }));
    });

    await queue.enqueue(job({ jobId: "first" }));
    expect(await queue.drain()).toBe(2);
    expect(ran).toEqual(["first", "second"]);
  });

  it("leaves work scheduled beyond the drain point alone", async () => {
    const start = Date.now();
    queue.process(async (entry) => {
      ran.push(entry.jobId);
      if (entry.jobId === "now") {
        await queue.enqueue(job({ jobId: "tomorrow" }), { delayMs: 86_400_000 });
      }
    });

    await queue.enqueue(job({ jobId: "now" }));
    await queue.drain(start);

    expect(ran).toEqual(["now"]);
    expect(queue.pending().map((entry) => entry.jobId)).toEqual(["tomorrow"]);
  });

  it("runs due work in the order it was scheduled, so a rerun is identical", async () => {
    await queue.enqueue(job({ jobId: "a" }));
    await queue.enqueue(job({ jobId: "b" }));
    await queue.enqueue(job({ jobId: "c" }));

    await queue.drain();
    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("reports when a job is due, for the simulator's clock", async () => {
    const start = Date.now();
    await queue.enqueue(job({ jobId: "scheduled" }), { delayMs: 60_000 });

    const dueAt = queue.dueAt("scheduled");
    expect(dueAt).not.toBeNull();
    expect(dueAt! - start).toBeGreaterThanOrEqual(59_000);
    expect(queue.dueAt("nonexistent")).toBeNull();
  });

  it("clears everything, so a reseeded demo has no ghosts scheduled against it", async () => {
    await queue.enqueue(job({ jobId: "a" }));
    await queue.enqueue(job({ jobId: "b" }), { delayMs: 60_000 });

    await queue.clear();

    expect(queue.pending()).toEqual([]);
    expect(await queue.drain(Date.now() + 86_400_000)).toBe(0);
    expect(ran).toEqual([]);
  });

  it("refuses to run without a handler rather than silently dropping work", async () => {
    const bare = new InlineActionQueue();
    await bare.enqueue(job());
    await expect(bare.drain()).rejects.toThrow("no handler registered");
  });
});
