import type { LedgerActor } from "@prisma/client";

import { GENESIS_SHA256, chainHash, chainSha256 } from "./ledger-digest";
import { buildSeed, type PayloadValue } from "./ledger-seed";

/**
 * Chain verification, as one pure function.
 *
 * Kept free of Prisma and Nest for the same reason `policy-gate.evaluate.ts` is:
 * this is the code someone auditing the audit trail would read, and it should
 * be readable — and testable — without a database running.
 *
 * It is a port of `frontend/src/lib/ledger-verify.ts` with one addition the
 * browser cannot make. The browser is handed a `seed` and has to hash the
 * string it was given; this can rebuild that string from the columns and check
 * that the row still produces its own preimage (D-74). That closes the gap
 * where a payload is edited in place and the seed left alone — the naive tamper,
 * and the only one an ORM makes easy.
 */

export type VerifiableRow = {
  chain: string;
  seq: number;
  hash: string;
  prevHash: string;
  sha256: string;
  prevSha256: string;
  seed: string;
  actor: LedgerActor;
  action: string;
  at: Date;
  detail: string;
  /** The case reference this row belongs to ("C-1195"), or null on the policy chain. */
  caseRef: string | null;
  payload: PayloadValue;
};

export type BrokenLink = { id: string; chain: string; seq: number; reason: string };

/** Chain plus sequence, unique by definition — the id the contract uses. */
export function rowId(row: { chain: string; seq: number }): string {
  return `${row.chain}#${row.seq}`;
}

/**
 * One chain, oldest row first.
 *
 * The important detail is which previous digest each row is hashed against: the
 * one this pass just *recomputed*, never the one stored beside the row.
 * Verifying against the stored value would make a chain of forged rows verify
 * perfectly — each row would agree with the neighbour it names, and nothing
 * would ever be checked against the payloads underneath. Chaining from the
 * recomputed digest is what makes one altered row fail, and then every row
 * after it fail with it.
 */
export function verifyChainRows(chain: string, rows: VerifiableRow[]): BrokenLink[] {
  const broken: BrokenLink[] = [];

  // Null until the first row: the genesis link is whatever that row names.
  let recomputedPrev: string | null = null;
  let recomputedPrevSha: string | null = null;
  let diverged = false;

  for (const row of rows) {
    const id = rowId(row);
    const rebuilt = rebuildSeed(row);

    if (rebuilt !== row.seed) {
      broken.push({
        id,
        chain,
        seq: row.seq,
        reason:
          "row no longer produces its own preimage — a field or the payload was changed after it was written",
      });
      diverged = true;
    }

    const link = recomputedPrev ?? row.prevHash;
    const linkSha = recomputedPrevSha ?? (row.prevSha256 || GENESIS_SHA256);

    // A link that disagrees before anything has diverged means a row was
    // removed or reordered rather than edited.
    if (!diverged && recomputedPrev !== null && row.prevHash !== recomputedPrev) {
      broken.push({
        id,
        chain,
        seq: row.seq,
        reason: `link broken — this row points at ${row.prevHash}, but the row before it hashes to ${recomputedPrev}`,
      });
      diverged = true;
    }

    const digest = chainHash(rebuilt, link);
    const sha = chainSha256(rebuilt, linkSha);
    const digestFailed = digest !== row.hash;
    const shaFailed = row.sha256 !== "" && sha !== row.sha256;

    if (digestFailed || shaFailed) {
      // One row, one finding: a reader chasing a break wants the row named
      // once, not once per digest that noticed it.
      if (broken[broken.length - 1]?.id !== id) {
        broken.push({
          id,
          chain,
          seq: row.seq,
          reason: diverged
            ? `chained to a digest that changed — recomputes to ${digest}, stored ${row.hash}`
            : `payload no longer hashes to its stored digest — recomputes to ${digest}, stored ${row.hash}`,
        });
      }
      diverged = true;
    }

    recomputedPrev = digest;
    recomputedPrevSha = sha;
  }

  return broken;
}

/** Group rows into their chains, oldest row first within each. */
export function chainsOf(rows: VerifiableRow[]): Map<string, VerifiableRow[]> {
  const byChain = new Map<string, VerifiableRow[]>();

  for (const row of rows) {
    const list = byChain.get(row.chain);
    if (list) list.push(row);
    else byChain.set(row.chain, [row]);
  }

  for (const list of byChain.values()) list.sort((a, b) => a.seq - b.seq);
  return byChain;
}

export function rebuildSeed(row: VerifiableRow): string {
  return buildSeed({
    chain: row.chain,
    seq: row.seq,
    atMs: row.at.getTime(),
    actor: row.actor,
    action: row.action,
    caseId: row.caseRef,
    detail: row.detail,
    payload: row.payload,
  });
}
