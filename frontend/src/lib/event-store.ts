"use client";

import { useSyncExternalStore } from "react";

import type { LedgerActor, LedgerRow, PayloadValue } from "@/lib/audit-data";
import { ledgerDigest } from "@/lib/ledger-digest";

/**
 * The session's append-only event store.
 *
 * One log, and every page reads it. Before this existed each surface kept its
 * own copy of what had happened - Case Detail held an override in `useState`,
 * the Approvals Queue held its decisions in another, the Policies page held a
 * version in a third - and the result was a product that contradicted itself
 * the moment anyone actually used it: a case marked resolved that still said
 * "in flight", decisions that never reached the Audit Explorer, a policy at v6
 * on one page and v4 on two others, and an override row that overwrote itself
 * instead of appending.
 *
 * Those were not four bugs. They were one missing thing, and this is it.
 *
 * Three rules, and they are the whole design:
 *
 * 1. **Append only.** There is no update and no delete, not as a policy but as
 *    an API - nothing here can reach a row that is already written. Resuming a
 *    paused case appends a resume; it does not remove the pause.
 * 2. **Rows are ledger rows.** A session event is a `LedgerRow`, chained and
 *    digested exactly like a server one, so the Audit Explorer can concatenate
 *    the two and verify them in one pass without knowing which is which.
 * 3. **State is a fold.** Nothing stores "this case is paused". Whether it is
 *    paused is computed from its events, so a screen cannot disagree with the
 *    log it is rendered from.
 *
 * This stands in for the Socket.IO `case.updated` / `approval.decided` rooms
 * (PRD 7.3): when the NestJS API lands, events arrive from the socket instead
 * of from a click, and every consumer below is unchanged.
 */

/* ------------------------------------------------------------------ */
/* The log                                                             */
/* ------------------------------------------------------------------ */

/** Replaced wholesale on append, never mutated - `useSyncExternalStore` compares by identity. */
let events: LedgerRow[] = [];

/** The last digest and sequence written to each chain. */
const tips = new Map<string, { hash: string; seq: number }>();

const listeners = new Set<() => void>();

/** A stable empty array: a fresh `[]` per call would loop the store forever. */
const EMPTY: LedgerRow[] = [];

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type AppendInput = {
  /** The chain this belongs to: a case id, or `policy`. */
  chain: string;
  actor: LedgerActor;
  action: string;
  detail: string;
  payload: PayloadValue;
  caseId?: string | null;
  masked?: string[];
  /**
   * Where this chain stood on the server, for the first append to it. Passed
   * per call rather than registered up front so there is no ordering hazard
   * between a component mounting and a person clicking.
   */
  tip?: { hash: string; seq: number };
};

/**
 * Write one event.
 *
 * The digest covers the row's own contents and the digest before it in the
 * same chain, computed with the ledger's own function - so a row written by a
 * click in the browser verifies in the Audit Explorer exactly like a row
 * written by the gate.
 */
export function appendEvent(input: AppendInput): LedgerRow {
  const tip = tips.get(input.chain) ?? input.tip ?? { hash: "0".repeat(10), seq: 0 };
  const seq = tip.seq + 1;
  const seed = `${input.chain}|${seq - 1}|${input.action}|${input.detail}`;
  const hash = ledgerDigest(`${seed}|${tip.hash}`);

  const row: LedgerRow = {
    id: `${input.chain}#${seq}`,
    chain: input.chain,
    seq,
    hash,
    prevHash: tip.hash,
    seed,
    actor: input.actor,
    action: input.action,
    // Real wall clock: these happen while somebody is watching, and stamping
    // them against the batch anchor would put a decision made now underneath
    // the rows it followed.
    atMs: Date.now(),
    detail: input.detail,
    caseId: input.caseId ?? null,
    masked: input.masked ?? [],
    payload: input.payload,
  };

  tips.set(input.chain, { hash, seq });
  events = [...events, row];
  for (const listener of listeners) listener();
  return row;
}

/** Every event written this session, in the order it was written. */
export function useSessionEvents(): LedgerRow[] {
  return useSyncExternalStore(
    subscribe,
    () => events,
    // The server has written nothing, so the first client render matches.
    () => EMPTY,
  );
}

/** Read once, outside React. */
export function sessionEvents(): LedgerRow[] {
  return events;
}

/* ------------------------------------------------------------------ */
/* Folds                                                               */
/* ------------------------------------------------------------------ */

export const OVERRIDE_ACTIONS = {
  pause: "AGENT_PAUSED_BY_HUMAN",
  resume: "AGENT_RESUMED_BY_HUMAN",
  escalate: "ESCALATED_BY_HUMAN",
  resolve: "RESOLVED_EXTERNALLY",
} as const;

export type OverrideKind = keyof typeof OVERRIDE_ACTIONS;

export type CaseState = {
  paused: boolean;
  takenByHuman: boolean;
  /** Closed outside Tugboat. Terminal: nothing reopens it. */
  resolvedExternally: boolean;
  /** The most recent override, for the note on the outcome card. */
  last: OverrideKind | null;
  /** Approved / rejected here this session, if it was. */
  decision: "approved" | "rejected" | null;
  /** How many events this session added to the case. */
  appended: number;
};

/**
 * What the events say about one case.
 *
 * A fold, not a flag. `paused` is false after a resume because a resume was
 * appended after the pause - the pause is still on the ledger, and still
 * visible in the audit panel, which is the point.
 */
export function caseStateOf(all: LedgerRow[], caseId: string): CaseState {
  const state: CaseState = {
    paused: false,
    takenByHuman: false,
    resolvedExternally: false,
    last: null,
    decision: null,
    appended: 0,
  };

  for (const row of all) {
    if (row.chain !== caseId) continue;
    state.appended += 1;

    switch (row.action) {
      case OVERRIDE_ACTIONS.pause:
        state.paused = true;
        state.last = "pause";
        break;
      case OVERRIDE_ACTIONS.resume:
        state.paused = false;
        state.takenByHuman = false;
        state.last = "resume";
        break;
      case OVERRIDE_ACTIONS.escalate:
        state.takenByHuman = true;
        state.paused = true;
        state.last = "escalate";
        break;
      case OVERRIDE_ACTIONS.resolve:
        state.resolvedExternally = true;
        state.paused = true;
        state.last = "resolve";
        break;
      case "APPROVAL_DECIDED": {
        const payload = row.payload;
        const decision =
          payload !== null && typeof payload === "object" && !Array.isArray(payload)
            ? payload.decision
            : null;
        state.decision = decision === "REJECTED" ? "rejected" : "approved";
        break;
      }
      default:
        break;
    }
  }

  return state;
}

/**
 * The policy version in force.
 *
 * Folded from the log rather than held in a store of its own, which is what
 * let the Policies page reach v6 while the shell and the ledger were still
 * reporting v4.
 */
export function policyVersionOf(all: LedgerRow[], initial: string): string {
  let version = initial;
  for (const row of all) {
    if (row.action !== "POLICY_CHANGED") continue;
    const payload = row.payload;
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const next = payload.version;
      if (typeof next === "string") version = next;
    }
  }
  return version;
}

/** The version, for components that only need that one number. */
export function usePolicyVersion(initial: string): string {
  return policyVersionOf(useSessionEvents(), initial);
}

/* ------------------------------------------------------------------ */
/* Testing seam                                                        */
/* ------------------------------------------------------------------ */

/**
 * Drop everything. Exists for tests and for the dev-time hot reload path -
 * never called from the UI, which has no affordance that unwrites a row.
 */
export function __resetEventStore(): void {
  events = [];
  tips.clear();
  for (const listener of listeners) listener();
}
