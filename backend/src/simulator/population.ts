import { createHash } from "node:crypto";

import type { CaseType, RootCause } from "@prisma/client";

import type { NormalizedEvent } from "../ingestion/normalized-event";
import { DIFFICULTY, type DifficultyKey } from "./difficulty";
import { buildPersona, type Persona } from "./persona";
import { SeededRng } from "./seeded-rng";

/**
 * The batch, before the agent has seen any of it.
 *
 * Two things are drawn here and they are not the same thing. The *true* root
 * cause is a fact about the world, held back for grading. What the gateway
 * *reports* is an observation of that fact, and observations are imperfect:
 * some codes name the cause exactly, some are unmapped noise, and some point
 * confidently at the wrong answer. That gap is the entire reason a diagnosis
 * accuracy figure means anything — a simulator that handed the agent the true
 * cause in the error string would be grading a lookup table against itself.
 *
 * The mix of the three is calibrated so a realistic batch sends roughly two
 * cases in three through the rules table, one in four to the model, and leaves
 * a residue the model reports low confidence on — which is the shape the
 * deterministic-first architecture predicts (ADR-5).
 */

const RUPEE = 100;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Arrivals are rounded onto this grid so a batch can ingest them in groups.
 *
 * Three hours, chosen from the run's cost rather than from realism. Two hundred
 * arrivals at two hundred distinct instants are two hundred sets of round trips
 * taken strictly in turn against a database on the other side of an ocean; on a
 * three-hour grid they arrive nine or ten at a time and overlap. Eight distinct
 * arrival times a day still puts half the batch inside the quiet window, which
 * is what the grid must not cost — a batch that only ever opened cases during
 * office hours could never prove that quiet hours defer anything.
 */
const ARRIVAL_GRID_MS = 60_000;

export type Observable = {
  code: string | null;
  reason: string | null;
  source: string | null;
  /** Which lane this code is expected to land in, for the run's own narration. */
  lane: "faithful" | "ambiguous" | "misleading";
};

/**
 * What each true cause looks like from outside.
 *
 * `misleading` entries are the honest half: a bank that reports a timeout when
 * the customer simply had no balance is an everyday occurrence, and an agent
 * that never gets one wrong has not been tested.
 *
 * The distinction between `ambiguous` and `misleading` is a fact about the
 * rules table, not a label. An ambiguous code is one no rule matches, so the
 * case goes to the model; a misleading one matches a rule that names the wrong
 * cause. Getting that backwards is easy and was got backwards once: the rules
 * search the error *code* as well as the reason, so a reason meant to be
 * unreadable carried under `GATEWAY_ERROR` was read confidently as a
 * degradation by R-05, and a fifth of the batch was misdiagnosed by
 * construction rather than by the agent (B-29).
 */
const OBSERVABLES: Record<RootCause, (readonly [Observable, number])[]> = {
  INSUFFICIENT_FUNDS: [
    [
      {
        code: "BAD_REQUEST_ERROR",
        reason: "payment_failed_insufficient_funds",
        source: "bank",
        lane: "faithful",
      },
      64,
    ],
    [
      {
        code: "BAD_REQUEST_ERROR",
        reason: "payment_declined_by_bank",
        source: "bank",
        lane: "ambiguous",
      },
      21,
    ],
    [
      { code: "BAD_REQUEST_ERROR", reason: "payment_not_captured", source: "gateway", lane: "ambiguous" },
      7,
    ],
    [{ code: "GATEWAY_ERROR", reason: "gateway_timeout", source: "gateway", lane: "misleading" }, 8],
  ],
  BANK_GATEWAY_DEGRADED: [
    [{ code: "GATEWAY_ERROR", reason: "gateway_timeout", source: "gateway", lane: "faithful" }, 42],
    [{ code: "GATEWAY_ERROR", reason: "bank_not_available", source: "bank", lane: "faithful" }, 24],
    [{ code: "GATEWAY_ERROR", reason: "upi_collect_timeout", source: "gateway", lane: "faithful" }, 15],
    [
      { code: "BAD_REQUEST_ERROR", reason: "issuer_unreachable", source: "gateway", lane: "ambiguous" },
      12,
    ],
    [
      {
        code: "BAD_REQUEST_ERROR",
        reason: "payment_failed_insufficient_funds",
        source: "bank",
        lane: "misleading",
      },
      7,
    ],
  ],
  CARD_EXPIRED: [
    [{ code: "BAD_REQUEST_ERROR", reason: "payment_card_expired", source: "issuer", lane: "faithful" }, 60],
    [{ code: "BAD_REQUEST_ERROR", reason: "invalid_expiry_date", source: "issuer", lane: "faithful" }, 18],
    [
      {
        code: "BAD_REQUEST_ERROR",
        reason: "card_declined_by_issuer",
        source: "issuer",
        lane: "ambiguous",
      },
      16,
    ],
    [
      { code: "BAD_REQUEST_ERROR", reason: "mandate_not_active", source: "bank", lane: "misleading" },
      6,
    ],
  ],
  MANDATE_REVOKED: [
    [
      { code: "BAD_REQUEST_ERROR", reason: "mandate_revoked_by_customer", source: "bank", lane: "faithful" },
      57,
    ],
    [{ code: "BAD_REQUEST_ERROR", reason: "mandate_not_active", source: "bank", lane: "faithful" }, 20],
    [
      { code: "BAD_REQUEST_ERROR", reason: "debit_rejected_at_bank", source: "bank", lane: "ambiguous" },
      16,
    ],
    [
      { code: "BAD_REQUEST_ERROR", reason: "payment_card_expired", source: "issuer", lane: "misleading" },
      7,
    ],
  ],
  CUSTOMER_DISTRACTED: [
    // No gateway error to read is itself the signal, and the rules table has a
    // row for exactly that (R-06, R-07).
    [{ code: null, reason: null, source: null, lane: "faithful" }, 80],
    [
      { code: "BAD_REQUEST_ERROR", reason: "payment_not_attempted", source: "gateway", lane: "ambiguous" },
      20,
    ],
  ],
  // Never drawn: UNKNOWN is what the agent says when it cannot tell, not a
  // thing that happens to a customer.
  UNKNOWN: [[{ code: null, reason: null, source: null, lane: "ambiguous" }, 1]],
};

/** Which causes each case type can actually have, and how often. */
const CAUSE_BY_TYPE: Record<CaseType, (readonly [RootCause, number])[]> = {
  PAYMENT_FAILED: [
    ["INSUFFICIENT_FUNDS", 44],
    ["BANK_GATEWAY_DEGRADED", 33],
    ["CARD_EXPIRED", 23],
  ],
  CHECKOUT_ABANDONED: [
    ["CUSTOMER_DISTRACTED", 74],
    ["BANK_GATEWAY_DEGRADED", 18],
    ["INSUFFICIENT_FUNDS", 8],
  ],
  MANDATE_FAILED: [
    ["INSUFFICIENT_FUNDS", 45],
    ["MANDATE_REVOKED", 34],
    ["BANK_GATEWAY_DEGRADED", 21],
  ],
  INVOICE_OVERDUE: [
    ["CUSTOMER_DISTRACTED", 62],
    ["INSUFFICIENT_FUNDS", 38],
  ],
};

/** Amount bands, matching the Pipeline's own filter buckets. */
const AMOUNT_BANDS: Record<CaseType, (readonly [readonly [number, number], number])[]> = {
  PAYMENT_FAILED: [
    [[249, 999], 22],
    [[1_000, 4_999], 41],
    [[5_000, 24_999], 30],
    [[25_000, 96_000], 7],
  ],
  CHECKOUT_ABANDONED: [
    [[349, 999], 26],
    [[1_000, 4_999], 46],
    [[5_000, 24_999], 25],
    [[25_000, 61_000], 3],
  ],
  MANDATE_FAILED: [
    [[199, 999], 31],
    [[1_000, 4_999], 49],
    [[5_000, 18_000], 20],
  ],
  INVOICE_OVERDUE: [
    [[2_400, 9_999], 28],
    [[10_000, 34_999], 46],
    // Deliberately not larger. Receivables really are the biggest cases a
    // merchant carries, but a band running to lakhs put more than half the
    // money at risk into fifteen percent of the batch, and the headline stopped
    // describing the batch and started describing the invoices in it.
    [[35_000, 95_000], 26],
  ],
};

const ORIGIN_KIND: Record<CaseType, string> = {
  PAYMENT_FAILED: "Razorpay payment",
  CHECKOUT_ABANDONED: "Razorpay order",
  MANDATE_FAILED: "Razorpay subscription",
  INVOICE_OVERDUE: "Razorpay invoice",
};

const ORIGIN_PREFIX: Record<CaseType, string> = {
  PAYMENT_FAILED: "pay",
  CHECKOUT_ABANDONED: "order",
  MANDATE_FAILED: "sub",
  INVOICE_OVERDUE: "inv",
};

const INSTRUMENTS: Record<CaseType, string[]> = {
  PAYMENT_FAILED: ["card", "upi", "netbanking", "wallet"],
  CHECKOUT_ABANDONED: ["upi", "card"],
  MANDATE_FAILED: ["emandate", "upi_autopay", "card"],
  INVOICE_OVERDUE: ["netbanking", "neft"],
};

/** Days of runway before a case is stale, before the difficulty scaling. */
const DEADLINE_DAYS: Record<CaseType, number> = {
  PAYMENT_FAILED: 7,
  CHECKOUT_ABANDONED: 4,
  MANDATE_FAILED: 12,
  INVOICE_OVERDUE: 16,
};

export type GeneratedCase = {
  index: number;
  persona: Persona;
  event: NormalizedEvent;
  observable: Observable;
  /** Milliseconds after the batch's start instant that this case arrives. */
  arrivalOffsetMs: number;
};

export type PopulationConfig = {
  runSeed: string;
  /**
   * Namespaces the generated event and origin ids.
   *
   * Separate from `runSeed` deliberately. The seed decides *what* the batch is
   * and must be identical across reruns; this decides what the objects in it
   * are *called*, and must not be — two runs of seed 42 are two batches, and
   * sharing an order id between them would make the second run's cases attach
   * to the first run's still-open ones.
   */
  runRef: string;
  batchSize: number;
  /** Percentage points per case type, summing to about 100. */
  mix: Record<CaseType, number>;
  difficulty: DifficultyKey;
  /** Wall-clock instant the batch's simulated timeline starts at. */
  startedAtMs: number;
  /** Stamped on every case so the run can be measured and cleared as a unit. */
  simRunId?: string;
  /** How long the arrivals are spread over. */
  arrivalWindowMs: number;
};

/**
 * The whole population, in one deterministic pass.
 *
 * Case types are laid out by *quota* rather than by rolling a die per case: a
 * batch asked for 40% payment failures should contain 40% payment failures, and
 * a sampler that gets there on average is a sampler that occasionally hands a
 * panelist a batch with eleven mandates in it. The shuffle afterwards is what
 * keeps arrivals interleaved rather than sorted by type.
 */
export function buildPopulation(config: PopulationConfig): GeneratedCase[] {
  const rng = new SeededRng(`${config.runSeed}/population`);
  const types = allocateTypes(config.mix, config.batchSize, rng);
  const preset = DIFFICULTY[config.difficulty];

  return types.map((caseType, index) => {
    const draw = new SeededRng(`${config.runSeed}/case/${index}`);
    const trueRootCause = draw.weighted(CAUSE_BY_TYPE[caseType]);
    const [[low, high]] = [draw.weighted(AMOUNT_BANDS[caseType])];
    const amountPaise = draw.int(low, high) * RUPEE;

    const persona = buildPersona({
      index,
      runSeed: config.runSeed,
      difficulty: config.difficulty,
      caseType,
      trueRootCause,
      amountPaise,
    });

    const observable = draw.weighted(OBSERVABLES[trueRootCause]);

    // Arrivals are spread across whole days rather than office hours on
    // purpose: a batch that never opens a case at 23:40 IST would never prove
    // that quiet hours defer anything.
    //
    // Arrival instants are distinct to the minute. The runner still works them
    // in hourly ticks — its own grid — so the cost is unchanged, but their
    // failure samples no longer pile onto one instant: on the old three-hour
    // grid nine failures landed together and tripped the degradation monitor
    // at every grid point the moment the monitor could fire at all (B-67).
    const arrivalOffsetMs =
      Math.round((draw.next() * config.arrivalWindowMs) / ARRIVAL_GRID_MS) * ARRIVAL_GRID_MS;
    const occurredAt = new Date(config.startedAtMs + arrivalOffsetMs);

    const tag = config.runRef.replace(/\W/g, "").slice(-10);
    const originId = `${ORIGIN_PREFIX[caseType]}_${tag}${String(index).padStart(4, "0")}`;

    const event: NormalizedEvent = {
      eventId: `sim_${tag}_${String(index).padStart(4, "0")}`,
      source: "simulator",
      eventType: `sim.${caseType.toLowerCase()}`,
      occurredAt,
      caseType,
      amountPaise,
      currency: "INR",
      origin: {
        kind: ORIGIN_KIND[caseType],
        id: originId,
        reference: caseType === "INVOICE_OVERDUE" ? `INV-${2600 + index}` : undefined,
      },
      // Contacts are scoped to the run (D-128). A persona's identity is its
      // seed, not its inbox: two runs of one seed are two worlds, and a
      // customer who opted out in one must not arrive in the next already
      // refusing every channel (B-49). Customer rows are resolved by contact,
      // so a run-specific address is what gives each run its own rows.
      customer: {
        name: persona.name,
        email: runScopedEmail(persona.email, tag),
        phone: runScopedPhone(tag, index),
        languagePref: persona.languagePref,
        segment: persona.segment,
      },
      failure:
        observable.code || observable.reason
          ? {
              code: observable.code ?? undefined,
              reason: observable.reason ?? undefined,
              source: observable.source ?? undefined,
            }
          : undefined,
      instrument: draw.pick(INSTRUMENTS[caseType]),
      deadlineAt: new Date(
        occurredAt.getTime() + DEADLINE_DAYS[caseType] * preset.deadlineScale * DAY_MS,
      ),
      // The batch enters through the same door as a Razorpay webhook, so the
      // raw payload is stored exactly as a real delivery would be.
      raw: {
        simulated: true,
        runSeed: config.runSeed,
        caseIndex: index,
        observableLane: observable.lane,
      },
      simRunId: config.simRunId,
    };

    return { index, persona, event, observable, arrivalOffsetMs };
  });
}

/**
 * Turns a percentage mix into an exact list of case types.
 *
 * Largest-remainder, so the counts sum to the batch size exactly and the
 * rounding error lands on the type that was closest to earning another case
 * rather than on whichever one happens to be last in the record.
 */
export function allocateTypes(
  mix: Record<CaseType, number>,
  batchSize: number,
  rng: SeededRng,
): CaseType[] {
  const entries = Object.entries(mix) as [CaseType, number][];
  const total = entries.reduce((sum, [, share]) => sum + share, 0) || 1;

  const exact = entries.map(([type, share]) => ({
    type,
    ideal: (share / total) * batchSize,
  }));

  const counts = exact.map((row) => ({ ...row, count: Math.floor(row.ideal) }));
  let assigned = counts.reduce((sum, row) => sum + row.count, 0);

  const byRemainder = [...counts].sort(
    (a, b) => b.ideal - Math.floor(b.ideal) - (a.ideal - Math.floor(a.ideal)),
  );

  for (let i = 0; assigned < batchSize; i += 1, assigned += 1) {
    byRemainder[i % byRemainder.length].count += 1;
  }

  const list: CaseType[] = [];
  for (const row of counts) {
    for (let i = 0; i < row.count; i += 1) list.push(row.type);
  }

  return rng.shuffle(list);
}

/** `priya.sharma.12@sim.tugboat.invalid` → `priya.sharma.12.sim0042q@sim.tugboat.invalid`. */
export function runScopedEmail(email: string, tag: string): string {
  const at = email.indexOf("@");
  return `${email.slice(0, at)}.${tag.toLowerCase()}${email.slice(at)}`;
}

/**
 * A ten-digit Indian mobile number that belongs to this run and this index.
 *
 * Derived from a digest rather than an offset so two runs cannot collide on
 * a number the way they could on a counter; `98` keeps it in the mobile
 * range and the `.invalid`-style honesty is carried by the sandbox: no real
 * adapter is switched on for a batch.
 */
export function runScopedPhone(tag: string, index: number): string {
  const digest = createHash("sha256").update(`${tag}/${index}`).digest("hex");
  const eight = String(parseInt(digest.slice(0, 8), 16) % 100_000_000).padStart(8, "0");
  return `+9198${eight}`;
}
