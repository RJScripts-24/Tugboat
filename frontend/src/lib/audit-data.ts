/**
 * The append-only ledger, read (PRD 6.3, page 8 · PRD 7.2 ADR-9).
 *
 * Nothing here is a second copy of anything, and that claim is now structural
 * rather than careful. This file used to *build* the ledger in the browser out
 * of `getCaseDetail` and the policy revisions, so that a digest on this page and
 * the digest beside a case's timeline would be the same ten characters. They are
 * the same ten characters now because there is one ledger, it is a table, and
 * the backend wrote each row inside the transaction that earned it (D-75).
 *
 * Two decisions worth stating, since a payments panel will ask about both:
 *
 * 1. The chain is per case, not one global rope. A case's rows link to each
 *    other, which means one case can be verified on its own without replaying a
 *    ledger of thousands of unrelated rows — and removing a row from a case
 *    still breaks every row after it in that case. The policy pack is its own
 *    chain for the same reason.
 *
 * 2. Payloads are decision records, not archives. A row records what was decided
 *    and what it was decided from; it references large artifacts (a call
 *    transcript, a message body) by shape rather than embedding them. A ledger
 *    you cannot read at a glance is a ledger nobody audits.
 *
 * The verification the Audit Explorer runs has not moved. The browser still
 * rebuilds each row's preimage from the row's own columns (`ledger-seed.ts`) and
 * recomputes the chain (`ledger-verify.ts`) — the server is still not trusted to
 * say its own evidence is intact.
 */


/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export type LedgerActor = "BOA" | "POLICY" | "HUMAN" | "SYSTEM";

export const ACTOR_ORDER: LedgerActor[] = ["BOA", "POLICY", "HUMAN", "SYSTEM"];

export const ACTOR_META: Record<LedgerActor, { label: string; hex: string; note: string }> = {
  BOA: { label: "Boa", hex: "#9aeaff", note: "the agent — diagnoses, plans and executed actions" },
  POLICY: {
    label: "Policy Gate",
    hex: "#ffe886",
    note: "every check the gate ran, including the ones that blocked something",
  },
  HUMAN: {
    label: "Human",
    hex: "#fffdf8",
    note: "approvals, rejections, overrides and policy edits, each with a name",
  },
  SYSTEM: {
    label: "System",
    hex: "#f6f3ec",
    note: "webhooks, inbound messages and captured payments",
  },
};

/** A JSON payload, as it is stored. Values are already masked where masked. */
export type PayloadValue =
  | string
  | number
  | boolean
  | null
  | PayloadValue[]
  | { [key: string]: PayloadValue };

export type LedgerRow = {
  /** Stable across renders: chain plus sequence, which is unique by definition. */
  id: string;
  /** Which chain this row belongs to — a case id, or `policy`. */
  chain: string;
  seq: number;
  hash: string;
  prevHash: string;
  /**
   * Everything the digest covers except the previous hash. Shipped so the
   * browser can recompute the chain and check it, rather than being told the
   * chain is fine.
   */
  seed: string;
  actor: LedgerActor;
  action: string;
  atMs: number;
  detail: string;
  caseId: string | null;
  /** Dotted paths inside `payload` whose value was masked before it was stored. */
  masked: string[];
  payload: PayloadValue;
};

export type ChainTip = { hash: string; seq: number };

/** The digest of an empty chain, which is what a first row chains onto. */
export const GENESIS_HASH = "0".repeat(10);

/* ------------------------------------------------------------------ */
/* GET /audit                                                          */
/* ------------------------------------------------------------------ */

export type AuditFilters = {
  case?: string;
  chain?: string;
  actor?: LedgerActor[];
  action?: string[];
  fromMs?: number;
  toMs?: number;
  skip?: number;
  take?: number;
};

export type LedgerPage = {
  rows: LedgerRow[];
  total: number;
  tips: Record<string, ChainTip>;
};

/* ------------------------------------------------------------------ */
/* GET /audit/summary                                                  */
/* ------------------------------------------------------------------ */

export type LedgerSummary = {
  entries: number;
  chains: number;
  cases: number;
  byActor: Record<LedgerActor, number>;
  /** Distinct action types, most frequent first. */
  actions: { action: string; count: number }[];
  oldestMs: number;
  newestMs: number;
  maskedRows: number;
};

/**
 * The same figures, over a set of rows already in hand.
 *
 * Used by the Explorer to describe the current filter — "of the eleven thousand
 * rows, these four hundred" — which is a question about the selection rather
 * than about the ledger.
 */
export function summarise(rows: LedgerRow[]): LedgerSummary {
  const byActor: Record<LedgerActor, number> = { BOA: 0, POLICY: 0, HUMAN: 0, SYSTEM: 0 };
  const actions = new Map<string, number>();
  const chains = new Set<string>();
  const cases = new Set<string>();
  let maskedRows = 0;
  let oldestMs = Infinity;
  let newestMs = -Infinity;

  for (const row of rows) {
    byActor[row.actor] += 1;
    actions.set(row.action, (actions.get(row.action) ?? 0) + 1);
    chains.add(row.chain);
    if (row.caseId) cases.add(row.caseId);
    if (row.masked.length > 0) maskedRows += 1;
    if (row.atMs < oldestMs) oldestMs = row.atMs;
    if (row.atMs > newestMs) newestMs = row.atMs;
  }

  const now = Date.now();

  return {
    entries: rows.length,
    chains: chains.size,
    cases: cases.size,
    byActor,
    actions: [...actions.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)),
    oldestMs: oldestMs === Infinity ? now : oldestMs,
    newestMs: newestMs === -Infinity ? now : newestMs,
    maskedRows,
  };
}

/* ------------------------------------------------------------------ */
/* Row context                                                         */
/* ------------------------------------------------------------------ */

export type CaseIndex = Record<string, { label: string; cause: string; stage: string }>;

