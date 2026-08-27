import type { CaseType } from "@prisma/client";

import { applyRules } from "../agent-core/diagnosis-rules";
import { DIFFICULTY } from "./difficulty";
import { allocateTypes, buildPopulation, type GeneratedCase } from "./population";
import { SeededRng } from "./seeded-rng";

/**
 * The population, checked against the thing it is meant to challenge.
 *
 * The most valuable assertions here run the *real* rules table over the
 * generated error codes. A lane label is a claim about how a case will be read,
 * and a claim about someone else's code that nobody checks is a comment. This
 * suite caught the version where every "ambiguous" code carried
 * `GATEWAY_ERROR`, which R-05 matches on the code as well as the reason — so a
 * fifth of the batch was misdiagnosed by construction and the accuracy figure
 * was measuring the generator, not the agent (B-29).
 */

const MIX: Record<CaseType, number> = {
  PAYMENT_FAILED: 40,
  CHECKOUT_ABANDONED: 25,
  MANDATE_FAILED: 20,
  INVOICE_OVERDUE: 15,
};

const START = Date.UTC(2026, 7, 10, 3, 30);

function population(overrides: Partial<Parameters<typeof buildPopulation>[0]> = {}) {
  return buildPopulation({
    runSeed: "42/realistic/214",
    runRef: "SIM-0042-A",
    batchSize: 214,
    mix: MIX,
    difficulty: "realistic",
    startedAtMs: START,
    arrivalWindowMs: 3 * 24 * 60 * 60_000,
    ...overrides,
  });
}

describe("allocateTypes", () => {
  it("hits the requested mix exactly rather than on average", () => {
    const types = allocateTypes(MIX, 214, new SeededRng("alloc"));
    const counts = types.reduce<Record<string, number>>(
      (acc, type) => ({ ...acc, [type]: (acc[type] ?? 0) + 1 }),
      {},
    );

    expect(types).toHaveLength(214);
    expect(counts.PAYMENT_FAILED).toBe(86);
    expect(counts.CHECKOUT_ABANDONED).toBe(53);
    expect(counts.MANDATE_FAILED).toBe(43);
    expect(counts.INVOICE_OVERDUE).toBe(32);
  });

  it("still sums to the batch size when the shares do not divide evenly", () => {
    for (const size of [10, 37, 99, 101, 500]) {
      const types = allocateTypes(MIX, size, new SeededRng(`alloc/${size}`));
      expect(types).toHaveLength(size);
    }
  });

  it("interleaves types rather than handing back a sorted list", () => {
    const types = allocateTypes(MIX, 214, new SeededRng("alloc"));
    const sorted = [...types].sort();
    expect(types).not.toEqual(sorted);
  });
});

describe("buildPopulation", () => {
  it("produces the identical batch for the identical seed", () => {
    const a = population();
    const b = population();

    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("produces a different batch for a different seed", () => {
    const a = population();
    const b = population({ runSeed: "43/realistic/214" });

    expect(a.map((row) => row.event.amountPaise)).not.toEqual(
      b.map((row) => row.event.amountPaise),
    );
  });

  it("names objects by the run, not by the seed, so a rerun does not collide", () => {
    const first = population({ runRef: "run-one" });
    const second = population({ runRef: "run-two" });

    // Identical batch, different object ids: the second run of seed 42 must not
    // attach its cases to the first run's still-open ones.
    expect(first.map((row) => row.event.amountPaise)).toEqual(
      second.map((row) => row.event.amountPaise),
    );
    expect(first[0].event.origin.id).not.toEqual(second[0].event.origin.id);
    expect(new Set(first.map((row) => row.event.origin.id)).size).toBe(first.length);
  });

  it("never hands the agent UNKNOWN as a true cause", () => {
    // UNKNOWN is the agent declining to answer. It is not something that
    // happens to a customer, and a batch containing it as ground truth would be
    // ungradeable.
    for (const row of population()) {
      expect(row.persona.trueRootCause).not.toBe("UNKNOWN");
    }
  });

  it("opens roughly half its cases inside the quiet window", () => {
    const batch = population();

    // Arrivals sit on a three-hour grid so the runner can ingest them in
    // groups, which trades distinct arrival times for throughput. What the grid
    // must NOT trade away is coverage of the quiet window: a batch that only
    // ever opened cases during office hours could never prove that quiet hours
    // defer anything, and the grid is only acceptable while this holds.
    const IST_OFFSET_MIN = 5 * 60 + 30;
    const quiet = batch.filter((row) => {
      const minute =
        (Math.floor(row.event.occurredAt.getTime() / 60_000) + IST_OFFSET_MIN) % 1440;
      return minute >= 21 * 60 || minute < 9 * 60;
    });

    expect(quiet.length / batch.length).toBeGreaterThan(0.35);
    expect(quiet.length / batch.length).toBeLessThan(0.65);
  });

  it("gives every case a deadline ahead of its own arrival", () => {
    for (const row of population()) {
      expect(row.event.deadlineAt!.getTime()).toBeGreaterThan(row.event.occurredAt.getTime());
    }
  });

  it("halves the runway on the hostile preset, as the preset says out loud", () => {
    const realistic = population()[0];
    const hostile = population({ difficulty: "hostile" });

    expect(DIFFICULTY.hostile.deadlineScale).toBe(0.5);
    const span = (row: GeneratedCase) =>
      row.event.deadlineAt!.getTime() - row.event.occurredAt.getTime();

    const sameType = hostile.find((row) => row.event.caseType === realistic.event.caseType)!;
    expect(span(sameType)).toBeLessThan(span(realistic));
  });
});

describe("the error codes are an honest observation of the cause", () => {
  const batch = population();

  const lanes = (lane: "faithful" | "ambiguous" | "misleading") =>
    batch.filter((row) => row.observable.lane === lane);

  const diagnose = (row: GeneratedCase) =>
    applyRules({
      caseType: row.event.caseType,
      failureCode: row.event.failure?.code ?? null,
      failureReason: row.event.failure?.reason ?? null,
      failureSource: row.event.failure?.source ?? null,
      instrument: row.event.instrument ?? null,
      gatewayDegraded: false,
    });

  it("makes every faithful code resolve to the true cause in the real rules table", () => {
    for (const row of lanes("faithful")) {
      const hit = diagnose(row);
      // A degradation reported as a server error only resolves when the
      // detector has an incident open, which this call deliberately does not.
      if (!hit) continue;
      expect(hit.rootCause).toBe(row.persona.trueRootCause);
    }
  });

  it("makes every ambiguous code genuinely unreadable — no rule claims it", () => {
    for (const row of lanes("ambiguous")) {
      expect(diagnose(row)).toBeNull();
    }
  });

  it("makes every misleading code resolve confidently to the wrong cause", () => {
    for (const row of lanes("misleading")) {
      const hit = diagnose(row);
      expect(hit).not.toBeNull();
      expect(hit!.rootCause).not.toBe(row.persona.trueRootCause);
    }
  });

  it("sends most of the batch through the table and a real minority to the model", () => {
    const ambiguous = lanes("ambiguous").length / batch.length;
    const misleading = lanes("misleading").length / batch.length;

    // The shape the deterministic-first architecture predicts: the table
    // answers the great majority, the model earns the residue, and the agent
    // gets a real chance to be wrong.
    expect(ambiguous).toBeGreaterThan(0.1);
    expect(ambiguous).toBeLessThan(0.35);
    expect(misleading).toBeGreaterThan(0.02);
    expect(misleading).toBeLessThan(0.12);
  });
});
