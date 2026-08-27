import { AsyncLocalStorage } from "node:async_hooks";

import { Injectable } from "@nestjs/common";

/**
 * The time the agent believes it is.
 *
 * Recovery is mostly waiting, and every bound that protects a person is a
 * statement about time: quiet hours, the 20-hour cool-down, the three-day
 * mandate spacing, a deadline. A batch of two hundred cases cannot spend two
 * hundred real days proving those bounds hold, so the run needs to move the
 * clock — and a clock that can be moved is a clock that must not be moved for
 * everybody.
 *
 * The offset therefore lives in an async-context frame rather than in a field.
 * Work started inside `runShifted` sees shifted time; anything else on the
 * process — a live webhook arriving mid-batch, an approver clicking a button —
 * keeps reading the wall clock. The frame is a mutable object on purpose: the
 * batch runner advances `offsetMs` between drains, and every job it then runs
 * inherits the new value without re-entering the context.
 */
export type ClockFrame = {
  offsetMs: number;
  /**
   * A simulated instant to stand still at.
   *
   * An offset alone is not enough for a batch. `Date.now() + offset` keeps
   * advancing while a tick runs, so two cases due at the same simulated hour
   * are worked against clocks a few hundred milliseconds apart — which is
   * invisible almost everywhere and decisive at a boundary: one case falls
   * inside quiet hours and its neighbour does not, and the run stops
   * reproducing (B-35). When the batch says the time is 09:00, it is 09:00 for
   * everything due at 09:00.
   */
  fixedMs?: number;
};

@Injectable()
export class ClockService {
  private readonly frames = new AsyncLocalStorage<ClockFrame>();

  now(): Date {
    return new Date(this.nowMs());
  }

  nowMs(): number {
    const frame = this.frames.getStore();
    if (!frame) return Date.now();

    return frame.fixedMs ?? Date.now() + frame.offsetMs;
  }

  /** Zero outside a shifted context, which is every path except a batch run. */
  get offsetMs(): number {
    return this.frames.getStore()?.offsetMs ?? 0;
  }

  get shifted(): boolean {
    return this.frames.getStore() !== undefined;
  }

  /**
   * Runs `fn` with time shifted by `frame.offsetMs`.
   *
   * Only the simulator calls this. Mutating the frame while `fn` runs is the
   * intended use: that is how a batch advances from Monday to Thursday between
   * two drains of the queue.
   */
  runShifted<T>(frame: ClockFrame, fn: () => T): T {
    return this.frames.run(frame, fn);
  }
}
