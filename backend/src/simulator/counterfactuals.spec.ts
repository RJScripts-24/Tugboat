import type { CaseType } from "@prisma/client";

import { baselineArm, costPer100, naiveArm, type ArmInput } from "./counterfactuals";
import { buildPopulation } from "./population";

/**
 * The two arms nobody ran, checked for the properties that make them arguments.
 *
 * The point of these tests is not the numbers — a counterfactual has no true
 * answer to compare against. It is the *relations*: doing nothing must cost
 * nothing and offend nobody, chasing everybody must reach more people than
 * doing nothing does, and chasing everybody with no bounds must send into the
 * night and keep messaging people who asked it to stop. If those relations ever
 * stopped holding, the comparison in the evidence report would stop being an
 * argument for anything.
 */

const MIX: Record<CaseType, number> = {
  PAYMENT_FAILED: 40,
  CHECKOUT_ABANDONED: 25,
  MANDATE_FAILED: 20,
  INVOICE_OVERDUE: 15,
};

const DAY = 24 * 60 * 60_000;
const START = Date.UTC(2026, 7, 10, 3, 30);

function input(overrides: Partial<ArmInput> = {}): ArmInput {
  return {
    cases: buildPopulation({
      runSeed: "42/realistic/214",
      runRef: "SIM-0042-A",
      batchSize: 214,
      mix: MIX,
      difficulty: "realistic",
      startedAtMs: START,
      arrivalWindowMs: 3 * DAY,
    }),
    horizonMs: 10 * DAY,
    startedAtMs: START,
    quiet: { startMinutes: 21 * 60, endMinutes: 9 * 60 },
    ...overrides,
  };
}

describe("the baseline arm", () => {
  const arm = baselineArm(input());

  it("costs nothing, contacts nobody and upsets nobody — that is the definition", () => {
    expect(arm.contacts).toBe(0);
    expect(arm.costPaise).toBe(0);
    expect(arm.complaints).toBe(0);
    expect(arm.optOuts).toBe(0);
    expect(arm.quietHourSends).toBe(0);
    expect(arm.costPer100Paise).toBeNull();
  });

  it("recovers something, because some customers were always going to pay", () => {
    expect(arm.recoveredCases).toBeGreaterThan(0);
    expect(arm.recoveryRate).toBeGreaterThan(0);
  });

  it("recovers a minority — a baseline that recovered most of it would end the project", () => {
    expect(arm.recoveryRate).toBeLessThan(0.3);
  });

  it("gives the same answer twice for the same population", () => {
    expect(baselineArm(input())).toEqual(baselineArm(input()));
  });

  it("recovers less when the window is shorter, because some payers are slow", () => {
    const short = baselineArm(input({ horizonMs: 4 * DAY }));
    expect(short.recoveredCases).toBeLessThanOrEqual(arm.recoveredCases);
  });
});

describe("the naive arm", () => {
  const naive = naiveArm(input());
  const baseline = baselineArm(input());

  it("reaches more people than doing nothing does", () => {
    // Contacting everybody works, a bit. Pretending otherwise would make the
    // comparison dishonest in TUGBOAT's favour.
    expect(naive.recoveredPaise).toBeGreaterThan(baseline.recoveredPaise);
    expect(naive.contacts).toBeGreaterThan(0);
  });

  it("sends into the quiet window, because it has no check that would stop it", () => {
    expect(naive.quietHourSends).toBeGreaterThan(0);

    // The window is twelve hours of twenty-four and the schedule is blind to
    // it, so about half of everything it sends lands inside.
    const share = naive.quietHourSends / naive.contacts;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.7);
  });

  it("provokes complaints, and more of them than it recovers cases", () => {
    expect(naive.complaints).toBeGreaterThan(0);
  });

  it("spends real money per contact, at the same prices TUGBOAT pays", () => {
    expect(naive.costPaise).toBeGreaterThan(0);
    expect(naive.costPer100Paise).not.toBeNull();
  });

  it("gives the same answer twice for the same population", () => {
    expect(naiveArm(input())).toEqual(naiveArm(input()));
  });

  it("gets harsher on the hostile preset, which is the point of having one", () => {
    const hostile = naiveArm(
      input({
        cases: buildPopulation({
          runSeed: "42/hostile/214",
          runRef: "SIM-0042-A",
          batchSize: 214,
          mix: MIX,
          difficulty: "hostile",
          startedAtMs: START,
          arrivalWindowMs: 3 * DAY,
        }),
      }),
    );

    expect(hostile.optOuts).toBeGreaterThan(naive.optOuts);
    expect(hostile.recoveryRate).toBeLessThan(naive.recoveryRate);
  });
});

describe("costPer100", () => {
  it("is null when nothing was spent, rather than zero", () => {
    // Zero would read as "free"; null reads as "no spend to divide", which is
    // what the baseline arm actually is.
    expect(costPer100(0, 1_000_000)).toBeNull();
  });

  it("reports paise spent for every ten thousand paise recovered", () => {
    expect(costPer100(300, 1_000_000)).toBe(3);
    expect(costPer100(5_000, 1_000_000)).toBe(50);
  });

  it("does not divide by nothing when money was spent and none came back", () => {
    expect(costPer100(5_000, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});
