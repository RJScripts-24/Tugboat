/**
 * What the rest of the system is allowed to announce.
 *
 * Every shape below is a frontend contract (`frontend/src/lib/*-data.ts`), not
 * a shape invented for the wire: `ActivityEntry` is the type the Boa activity
 * log already renders, `RunStep` is the type the Simulation Lab's runner feed
 * already draws. The gateway is a transport, so it gets to translate nothing —
 * a socket frame is the same object the page would have been handed by an
 * HTTP call, which is what makes "the feed and the endpoint agree" a property
 * of the type system rather than of vigilance.
 *
 * Declared in `common` and depending on no module, because both halves need
 * it: the publishers live in `cases`, `approvals`, `policy` and `simulator`,
 * and the subscriber lives in `realtime`. A union owned by either side would
 * be an import edge between them.
 */

/** `ActivityKind` in `frontend/src/lib/dashboard-data.ts`. */
export type ActivityKind =
  | "DETECT"
  | "DIAGNOSE"
  | "POLICY"
  | "POLICY_BLOCK"
  | "MESSAGE"
  | "CALL"
  | "RETRY"
  | "PROMISE"
  | "ESCALATE"
  | "HALT"
  | "RECOVERED";

/** `ActivityActor` — who acted, which is what an operator filters on first. */
export type ActivityActor = "BOA" | "POLICY" | "RECOVERY";

/** `ActivityEntry`, byte for byte. */
export type ActivityEntry = {
  id: string;
  kind: ActivityKind;
  actor: ActivityActor;
  /** "—" for an entry that belongs to no single case. */
  caseId: string;
  href?: string;
  title: string;
  meta: string;
  /** HH:MM:SS in IST — stamped by the writer, never by the reader. */
  time: string;
};

/** `RunStep` in `frontend/src/lib/simulation-data.ts`. */
export type RunStep = {
  /** Fraction of the batch complete when this line landed. */
  at: number;
  actor: ActivityActor;
  line: string;
  meta: string;
};

/** The running totals a progress frame carries, so the counters need no books of their own. */
export type RunTotals = {
  recoveredPaise: number;
  recoveredCases: number;
  contacts: number;
  escalations: number;
  stopped: number;
};

/**
 * The union.
 *
 * Every member names its merchant, because a socket room is per merchant and a
 * publisher that forgot to say whose event it was would be a cross-tenant leak
 * one `merchant_id` column away from mattering (PRD 9.1).
 */
export type DomainEvent =
  | { name: "activity.new"; merchantId: string; entry: ActivityEntry }
  | {
      name: "case.updated";
      merchantId: string;
      caseId: string;
      stage: string;
      /** The event kind that moved it, so a listener can decide without refetching. */
      kind: string;
      recoveredPaise: number;
      attempts: number;
    }
  | { name: "kpi.updated"; merchantId: string }
  | {
      name: "approval.pending";
      merchantId: string;
      approvalId: string;
      caseId: string;
      gate: string;
      /** The queue depth after this request joined it — the sidebar badge's number. */
      pending: number;
    }
  | {
      name: "approval.decided";
      merchantId: string;
      approvalId: string;
      caseId: string;
      decision: "APPROVED" | "REJECTED";
      pending: number;
    }
  | { name: "policy.changed"; merchantId: string; version: string }
  | {
      name: "sim.progress";
      merchantId: string;
      runId: string;
      /** 0 to 1. */
      progress: number;
      /** Null on a frame that only moved the bar. */
      step: RunStep | null;
      totals: RunTotals;
    }
  | {
      name: "sim.completed";
      merchantId: string;
      runId: string;
      status: "COMPLETED" | "FAILED";
      failureReason: string | null;
    };

export type DomainEventName = DomainEvent["name"];

/** Narrows the union to one member, so a subscriber gets the payload it asked for. */
export type DomainEventOf<N extends DomainEventName> = Extract<DomainEvent, { name: N }>;
