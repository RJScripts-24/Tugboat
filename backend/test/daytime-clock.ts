import type { ClockService } from "../src/common/clock.service";
import { istMinuteOfDay, isQuiet } from "../src/policy/ist-clock";

/**
 * Runs a test outside quiet hours, whatever time it happens to be.
 *
 * These suites assert that the agent contacts somebody. The gate only allows
 * that between 09:00 and 21:00 IST, so before this existed the integration
 * tier passed during the working day and failed every evening — twenty-nine
 * tests, all with the same shape: the case reaches POLICY_CHECK, nothing is
 * sent, and `attemptsUsed` stays 0. The gate was right every time; the tests
 * were reading the wall clock and calling it a fixture.
 *
 * The shift is the smallest one that does the job, and it is *nothing at all*
 * when the suite is already running in daylight — so a green afternoon run is
 * byte-for-byte the run it has always been, and only the evening changes. When
 * it is quiet hours, the frame moves forward to the next 09:30 IST rather than
 * backward, because these tests stamp some fixtures from the real clock and a
 * backward shift would place them in the agent's future.
 *
 * Quiet hours themselves are proven where they belong: against the pure gate
 * in `policy-gate.evaluate.spec.ts`, and end to end by the batch, which meets
 * the window on its own shifted clock.
 */

const OPEN_MINUTE = 9 * 60 + 30;
const DAY_MS = 24 * 60 * 60_000;

/** Zero in daylight; otherwise the jump forward to the next 09:30 IST. */
export function daylightOffsetMs(nowMs: number, quietStart = 21 * 60, quietEnd = 9 * 60): number {
  const minute = istMinuteOfDay(new Date(nowMs));
  if (!isQuiet(minute, quietStart, quietEnd)) return 0;

  const delta = ((OPEN_MINUTE - minute) % (24 * 60) + 24 * 60) % (24 * 60);
  return (delta === 0 ? DAY_MS : delta * 60_000);
}

/**
 * `it`, with the agent's clock held in daylight for the body.
 */
export function daylightIt(clock: () => ClockService) {
  return (name: string, fn: () => Promise<unknown>, timeout?: number): void => {
    it(
      name,
      async () => {
        // Computed when the test runs, not when it is collected, so a suite
        // that straddles 21:00 does not half-shift.
        const offsetMs = daylightOffsetMs(Date.now());
        if (offsetMs === 0) {
          await fn();
          return;
        }
        await clock().runShifted({ offsetMs }, fn);
      },
      timeout,
    );
  };
}
