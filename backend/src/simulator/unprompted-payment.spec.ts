import type { Persona } from "./persona";
import { selfRecoversBy, unpromptedPaymentAt } from "./persona-engine";

const HOUR_MS = 60 * 60_000;

function persona(overrides: Partial<Persona>): Persona {
  return { wouldSelfRecover: true, selfRecoverAfterHours: 34, ...overrides } as Persona;
}

/**
 * The arm that ran and the arms that were modelled must credit the same
 * customer on the same day. `selfRecoversBy` is what the baseline reads;
 * `unpromptedPaymentAt` is what the batch schedules. If they ever disagree, the
 * uplift figure is comparing two different populations (B-46).
 */
describe("the unprompted payment", () => {
  const openedAtMs = 1_000_000;

  it("lands exactly when the baseline says the customer would have paid", () => {
    const who = persona({ selfRecoverAfterHours: 34 });

    expect(unpromptedPaymentAt(who, openedAtMs, openedAtMs + 240 * HOUR_MS)).toBe(
      openedAtMs + 34 * HOUR_MS,
    );
  });

  it("agrees with the baseline on every horizon", () => {
    const who = persona({ selfRecoverAfterHours: 34 });

    for (const hours of [0, 1, 33, 34, 35, 100, 240]) {
      const horizonMs = openedAtMs + hours * HOUR_MS;
      const scheduled = unpromptedPaymentAt(who, openedAtMs, horizonMs) !== null;

      expect(scheduled).toBe(selfRecoversBy(who, hours));
    }
  });

  it("schedules nothing for a customer who was not going to pay", () => {
    const who = persona({ wouldSelfRecover: false, selfRecoverAfterHours: 3 });

    expect(unpromptedPaymentAt(who, openedAtMs, openedAtMs + 240 * HOUR_MS)).toBeNull();
    expect(selfRecoversBy(who, 240)).toBe(false);
  });
});
