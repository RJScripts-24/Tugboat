/**
 * What the ledger says about a case, as a fold.
 *
 * This module used to *be* the log. With no backend, the browser kept its own
 * append-only store — one array, digested and chained exactly like a server row
 * — because the alternative was four screens each holding their own copy of
 * what had happened and contradicting each other the moment anyone used the
 * product. Three rules made it work: append only, rows are ledger rows, and
 * state is a fold.
 *
 * The first two rules moved to Postgres, which is where they always belonged.
 * The third one stayed, and it is the whole file now.
 *
 * That is not a smaller idea. Nothing anywhere stores "this case is paused" as
 * a flag to be flipped: whether it is paused is computed from the rows on its
 * chain, so a resume is a row that follows a pause rather than one that erases
 * it, and the Case Detail audit panel shows both. A screen cannot disagree with
 * the log it is rendered from, because it has nothing else to read.
 */

import type { AuditEntry } from "./case-detail-data";

/* ------------------------------------------------------------------ */
/* The override vocabulary                                             */
/* ------------------------------------------------------------------ */

/**
 * The four ledger actions a human can write against a case.
 *
 * The same four strings the API writes (`case-overrides.service.ts`). They are
 * ledger actions rather than `EventKind`s on purpose: the timeline is the story
 * of the recovery, and "a human took this off the agent" is a fact about who
 * was holding it (D-108).
 */
export const OVERRIDE_ACTIONS = {
  pause: "AGENT_PAUSED_BY_HUMAN",
  resume: "AGENT_RESUMED_BY_HUMAN",
  escalate: "ESCALATED_BY_HUMAN",
  resolve: "RESOLVED_EXTERNALLY",
} as const;

export type OverrideKind = keyof typeof OVERRIDE_ACTIONS;

/** The API spells the fourth one out, because "resolve" alone says nothing about where. */
export type OverrideRoute = "pause" | "resume" | "escalate" | "resolve-external";

/** The route each override posts to. `resolve` is spelled out in the URL. */
export const OVERRIDE_ROUTES: Record<OverrideKind, OverrideRoute> = {
  pause: "pause",
  resume: "resume",
  escalate: "escalate",
  resolve: "resolve-external",
};

/* ------------------------------------------------------------------ */
/* The fold                                                            */
/* ------------------------------------------------------------------ */

export type CaseState = {
  paused: boolean;
  takenByHuman: boolean;
  /** Closed outside Tugboat. Terminal: nothing reopens it. */
  resolvedExternally: boolean;
  /** The most recent override, for the note on the outcome card. */
  last: OverrideKind | null;
  /** Approved or rejected, if a decision is on this chain. */
  decision: "approved" | "rejected" | null;
  /** How many human rows the chain carries. */
  appended: number;
};

const EMPTY_STATE: CaseState = {
  paused: false,
  takenByHuman: false,
  resolvedExternally: false,
  last: null,
  decision: null,
  appended: 0,
};

/**
 * What the rows say about one case.
 *
 * A fold, not a flag. `paused` is false after a resume because a resume was
 * written after the pause — the pause is still on the ledger, and still visible
 * in the audit panel, which is the point.
 *
 * Reads `action` and nothing else, so it works on the case's own audit entries
 * as served by `GET /cases/:id` without needing the full ledger row beside them.
 */
export function caseStateOf(rows: readonly AuditEntry[]): CaseState {
  const state: CaseState = { ...EMPTY_STATE };

  for (const row of rows) {
    switch (row.action) {
      case OVERRIDE_ACTIONS.pause:
        state.paused = true;
        state.last = "pause";
        state.appended += 1;
        break;
      case OVERRIDE_ACTIONS.resume:
        state.paused = false;
        state.takenByHuman = false;
        state.last = "resume";
        state.appended += 1;
        break;
      case OVERRIDE_ACTIONS.escalate:
        state.takenByHuman = true;
        state.paused = true;
        state.last = "escalate";
        state.appended += 1;
        break;
      case OVERRIDE_ACTIONS.resolve:
        state.resolvedExternally = true;
        state.paused = true;
        state.last = "resolve";
        state.appended += 1;
        break;
      case "APPROVAL_DECIDED":
        // The detail line is the decision's own sentence, written by the API
        // ("Approved by …" / "Rejected by …"). Read rather than re-derived, so
        // the panel and the timeline cannot disagree about which way it went.
        state.decision = row.detail.toLowerCase().startsWith("rejected")
          ? "rejected"
          : "approved";
        state.appended += 1;
        break;
      default:
        break;
    }
  }

  return state;
}
