import type { ApprovalGate } from "@prisma/client";

import { rejectionReasonsFor } from "../approvals/rejection-reasons";
import { SeededRng } from "./seeded-rng";

/**
 * The merchant, as a persona.
 *
 * Every escalation gate hands the case to a human, and a batch with no human in
 * it is a batch where every escalation is a dead end. That is not a neutral
 * simplification — it silently caps the recovery rate at "cases that never
 * needed a person", makes the approvals block of the evidence report a column
 * of zeroes, and would let a reader conclude the escalation path costs nothing
 * when in fact it costs a decision and a wait.
 *
 * So the batch simulates the merchant too, and says so. What it models is
 * deliberately thin: how long somebody takes to look, and how often they say
 * yes. It does not model good judgement — it does not read the draft or weigh
 * the case, because a simulated approver that always decided *correctly* would
 * flatter the agent exactly where a real approver would not.
 *
 * The rates below are per gate and reflect what each question actually is. A
 * B2B routing request is nearly always waved through, because the gate exists
 * to inform rather than to prevent. A discount is refused about a third of the
 * time, because it costs money. A hardship stand-down is usually granted,
 * because refusing is the unkind answer and most merchants are not unkind.
 */

export type MerchantDecision =
  | { kind: "approve"; afterMs: number; by: string }
  | { kind: "reject"; afterMs: number; by: string; reason: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How often each gate gets a yes. */
const APPROVAL_RATE: Record<ApprovalGate, number> = {
  b2b_high_value: 0.88,
  confidence_below_threshold: 0.61,
  discount_requires_approval: 0.66,
  hardship_language: 0.79,
};

/**
 * How long the merchant takes to answer, in hours.
 *
 * Log-normal-ish rather than uniform: most requests are answered in the next
 * hour or two, and a few sit over a weekend. That tail is why the report prints
 * a median rather than a mean — an average latency here would describe nobody.
 */
function responseDelayMs(rng: SeededRng): number {
  return rng.bool(0.72)
    ? rng.float(8 * MINUTE_MS, 3 * HOUR_MS)
    : rng.float(6 * HOUR_MS, 34 * HOUR_MS);
}

export const SIMULATED_APPROVER = "Simulated merchant · batch run";

/**
 * What the merchant does about one request.
 *
 * `key` must identify the *request* in a way that survives a rerun. This was
 * the approval row's `id`, with a comment claiming that made reruns
 * reproducible — and `Approval.id` is a `cuid()`, freshly random for every
 * row. So the merchant approved three requests on one run and two on the next
 * from the identical batch, and every figure downstream of an approval moved
 * with it (B-41). The caller now builds the key from the generated case's own
 * index and the simulated instant the request was raised, both of which are
 * properties of the seed rather than of the database.
 */
export function decideAs(key: string, gate: ApprovalGate): MerchantDecision {
  const rng = new SeededRng(`merchant/${key}`);
  const afterMs = responseDelayMs(rng);

  if (rng.bool(APPROVAL_RATE[gate])) {
    return { kind: "approve", afterMs, by: SIMULATED_APPROVER };
  }

  return {
    kind: "reject",
    afterMs,
    by: SIMULATED_APPROVER,
    // From the gate's own reason list rather than a free-typed string, so the
    // rejection reasons in the report are the ones the product actually offers.
    reason: rng.pick(rejectionReasonsFor(gate)),
  };
}
