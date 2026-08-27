import { ClockService } from "./clock.service";

describe("ClockService", () => {
  it("reads the wall clock outside a shifted context", () => {
    const clock = new ClockService();

    expect(clock.shifted).toBe(false);
    expect(clock.offsetMs).toBe(0);
    expect(Math.abs(clock.nowMs() - Date.now())).toBeLessThan(50);
  });

  it("shifts time only for work started inside the frame", () => {
    const clock = new ClockService();
    const DAY = 24 * 60 * 60_000;

    const outsideBefore = clock.nowMs();
    const inside = clock.runShifted({ offsetMs: 3 * DAY }, () => clock.nowMs());
    const outsideAfter = clock.nowMs();

    expect(inside - outsideBefore).toBeGreaterThan(3 * DAY - 1_000);
    expect(Math.abs(outsideAfter - outsideBefore)).toBeLessThan(1_000);
  });

  it("follows the frame when the batch advances it mid-run", () => {
    const clock = new ClockService();
    const frame = { offsetMs: 0 };

    const readings = clock.runShifted(frame, () => {
      const first = clock.nowMs();
      frame.offsetMs = 60 * 60_000;
      const second = clock.nowMs();
      return { first, second };
    });

    expect(readings.second - readings.first).toBeGreaterThan(59 * 60_000);
  });

  it("stands still inside a fixed frame, however long the work takes", async () => {
    const clock = new ClockService();
    const instant = Date.UTC(2026, 7, 12, 3, 30);

    const readings = await clock.runShifted({ offsetMs: 0, fixedMs: instant }, async () => {
      const first = clock.nowMs();
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { first, second: clock.nowMs() };
    });

    // Two cases due at the same simulated hour must be worked against the same
    // clock, however many real milliseconds pass between them (B-35).
    expect(readings.first).toBe(instant);
    expect(readings.second).toBe(instant);
  });

  it("keeps a concurrent unshifted caller on the wall clock", async () => {
    const clock = new ClockService();
    const DAY = 24 * 60 * 60_000;

    let unshifted = 0;
    const shifted = await clock.runShifted({ offsetMs: 10 * DAY }, async () => {
      const mine = clock.nowMs();
      await Promise.resolve();
      unshifted = await runOutside();
      return mine;
    });

    expect(shifted - unshifted).toBeGreaterThan(9 * DAY);
  });
});

/** Deliberately reads the wall clock: proves the frame shifts the service, not time itself. */
async function runOutside(): Promise<number> {
  await Promise.resolve();
  return Date.now();
}
