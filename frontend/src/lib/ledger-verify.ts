import { ledgerDigest } from "@/lib/ledger-digest";
import type { LedgerRow } from "@/lib/audit-data";

/**
 * Chain verification, written to run in the browser.
 *
 * This is the only place the verification can honestly live. A server that
 * writes the hashes and then reports them verified has proved nothing: the
 * check has to be recomputable by whoever is being asked to trust the log,
 * from the same inputs they were given. So the rows arrive carrying their
 * digest preimage, and this recomputes every one of them here.
 *
 * The module imports the digest and a type, and nothing else - keeping it out
 * of `audit-data` is what stops the case builder being dragged into the client
 * bundle behind it.
 */

export type ChainVerdict = {
  checked: number;
  chains: number;
  /** Rows that failed, in chain order. */
  broken: { id: string; chain: string; seq: number; reason: string }[];
};

export type ChainInput = { chain: string; rows: LedgerRow[] };

/** Group rows into their chains, oldest row first within each. */
export function chainsOf(rows: LedgerRow[]): ChainInput[] {
  const byChain = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const list = byChain.get(row.chain);
    if (list) list.push(row);
    else byChain.set(row.chain, [row]);
  }
  return [...byChain.entries()].map(([chain, list]) => ({
    chain,
    rows: [...list].sort((a, b) => a.seq - b.seq),
  }));
}

/**
 * Verify one chain.
 *
 * The important detail is which previous digest each row is hashed against:
 * the one this pass just *recomputed*, never the one the row has stored
 * beside it. Verifying against the stored value would make a chain of forged
 * rows verify perfectly - each row would agree with the neighbour it names,
 * and nothing would ever be checked against the payloads underneath. Chaining
 * from the recomputed digest is what makes one altered row fail, and then
 * every row after it fail with it.
 *
 * `tamperedId` writes nothing. It recomputes as if one row's payload had been
 * edited, so that cascade can be shown rather than described - the ledger
 * itself is untouched, and this page has no affordance that changes a row by
 * design (PRD 6.3, page 8).
 */
export function verifyChain(
  { chain, rows }: ChainInput,
  tamperedId?: string,
): ChainVerdict["broken"] {
  const broken: ChainVerdict["broken"] = [];
  // Null until the first row: the genesis link is whatever that row names,
  // which for this ledger is ten zeroes.
  let recomputedPrev: string | null = null;
  let diverged = false;

  for (const row of rows) {
    const link = recomputedPrev ?? row.prevHash;

    // A link that disagrees before anything has diverged means a row was
    // removed or reordered rather than edited.
    if (!diverged && recomputedPrev !== null && row.prevHash !== recomputedPrev) {
      broken.push({
        id: row.id,
        chain,
        seq: row.seq,
        reason: `link broken — this row points at ${row.prevHash}, but the row before it hashes to ${recomputedPrev}`,
      });
      diverged = true;
    }

    const seed = row.id === tamperedId ? `${row.seed}|EDITED` : row.seed;
    const digest = ledgerDigest(`${seed}|${link}`);

    if (digest !== row.hash) {
      if (!diverged) {
        broken.push({
          id: row.id,
          chain,
          seq: row.seq,
          reason: `payload no longer hashes to its stored digest — recomputes to ${digest}, stored ${row.hash}`,
        });
        diverged = true;
      } else if (broken[broken.length - 1]?.id !== row.id) {
        broken.push({
          id: row.id,
          chain,
          seq: row.seq,
          reason: `chained to a digest that changed — recomputes to ${digest}, stored ${row.hash}`,
        });
      }
    }

    recomputedPrev = digest;
  }

  return broken;
}

/** Every chain, in one pass. Used where progress reporting is not needed. */
export function verifyChains(rows: LedgerRow[], tamperedId?: string): ChainVerdict {
  const chains = chainsOf(rows);
  const broken = chains.flatMap((chain) => verifyChain(chain, tamperedId));
  return { checked: rows.length, chains: chains.length, broken };
}

/**
 * One row, checked on its own.
 *
 * Against its stored previous digest rather than a recomputed one, because
 * that is the question an expanded row is asking: does this payload produce
 * the digest written beside it. The chain-level question is the function
 * above.
 */
export function verifyRow(
  row: Pick<LedgerRow, "seed" | "prevHash" | "hash">,
): { digest: string; matches: boolean } {
  const digest = ledgerDigest(`${row.seed}|${row.prevHash}`);
  return { digest, matches: digest === row.hash };
}
