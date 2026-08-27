import type { LedgerRow, PayloadValue } from "@/lib/audit-data";
import { ledgerDigest } from "@/lib/ledger-digest";

/**
 * The digest preimage, rebuilt in the browser from the row's own columns.
 *
 * Until this existed the verifier hashed the `seed` string the server handed
 * it. That checks the chain - a row cannot be altered without breaking every
 * row after it - but it does not check that the seed still *describes* the row
 * printed beside it. A server that shipped an edited payload with the original
 * seed would have verified perfectly, and the one field an ORM makes easy to
 * edit is the payload.
 *
 * So the browser rebuilds the preimage the same way the writer built it, and
 * compares. The server already does this on its own side (D-74); doing it only
 * there would be the server verifying itself, which is the one place this
 * check is worth nothing.
 *
 * Every line below has a twin in `backend/src/audit/ledger-seed.ts`, and a
 * test in the backend compiles *this* file and runs the two side by side. They
 * are not allowed to drift: if they do, every row in the ledger stops
 * verifying, and that test says so before a panelist does.
 *
 * Type-only imports on purpose - erased at build, so pulling the verifier into
 * the client bundle does not pull the case builder along behind it.
 */

/** How many characters of the payload digest go into the seed. */
const PAYLOAD_DIGEST_LENGTH = 16;

/**
 * JSON with a fixed key order.
 *
 * `JSON.stringify` preserves insertion order, so the same payload built by two
 * code paths in a different order would serialise differently and digest
 * differently - a chain that breaks depending on which branch wrote the row.
 * Sorting the keys removes that entirely.
 */
export function canonicalJson(value: PayloadValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

export function payloadDigest(payload: PayloadValue): string {
  return ledgerDigest(canonicalJson(payload), PAYLOAD_DIGEST_LENGTH);
}

/** `\` and `|` escaped, so a field's own text can never look like a separator. */
function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

export type SeedFields = {
  chain: string;
  seq: number;
  atMs: number;
  actor: string;
  action: string;
  caseId: string | null;
  detail: string;
  payload: PayloadValue;
};

export function buildSeed(fields: SeedFields): string {
  return [
    escape(fields.chain),
    String(fields.seq),
    String(fields.atMs),
    escape(fields.actor),
    escape(fields.action),
    escape(fields.caseId ?? "-"),
    escape(fields.detail),
    payloadDigest(fields.payload),
  ].join("|");
}

/**
 * The preimage this row should have, read off the row itself.
 *
 * Never the stored `seed`. That string is the thing under test.
 */
export function rebuildSeed(row: LedgerRow): string {
  return buildSeed({
    chain: row.chain,
    seq: row.seq,
    atMs: row.atMs,
    actor: row.actor,
    action: row.action,
    caseId: row.caseId,
    detail: row.detail,
    payload: row.payload,
  });
}
