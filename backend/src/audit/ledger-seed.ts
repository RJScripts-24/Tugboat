import { ledgerDigest } from "./ledger-digest";

/**
 * The digest preimage, built from the row itself.
 *
 * `seed` is shipped to the browser so the chain can be recomputed there, which
 * makes its format part of the contract rather than an implementation detail.
 * Two properties are what make it worth anything:
 *
 * 1. **It is derived, never authored.** Every field the row asserts goes into
 *    it — including the payload, by digest — so editing any of them and leaving
 *    the seed alone produces a row whose seed no longer describes it. The
 *    verifier rebuilds the seed from the columns rather than trusting the
 *    stored string, so that mismatch is caught rather than believed (D-74).
 * 2. **It is unambiguous.** Fields are joined with `|`, and any `|` or `\` in a
 *    value is escaped first. Without that, a detail line containing a pipe
 *    could produce the same seed as a different row with different field
 *    boundaries — a collision an attacker chooses rather than one they have to
 *    find.
 *
 * The payload travels as a digest rather than inline because the ledger renders
 * this string on screen beside every row, and a preimage nobody can read is a
 * verification nobody performs.
 */

export type PayloadValue =
  string | number | boolean | null | PayloadValue[] | { [key: string]: PayloadValue };

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

/** How many characters of the payload digest go into the seed. */
const PAYLOAD_DIGEST_LENGTH = 16;

/**
 * JSON with a fixed key order.
 *
 * `JSON.stringify` preserves insertion order, so the same payload built by two
 * code paths in a different order would serialise differently and digest
 * differently — a chain that breaks depending on which branch wrote the row.
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
 * Which fields of a row were written masked.
 *
 * Read off the values rather than declared per event kind, exactly as the
 * frontend does. The mask marker is *in* the stored string — that is what
 * masking is here — so walking the payload for it cannot fall out of step with
 * what the payload actually holds, which a hand-maintained list of paths
 * eventually does.
 */
export function maskedPathsIn(value: PayloadValue, path = "", out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.includes("•") && path) out.push(path);
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => maskedPathsIn(item, `${path}[${index}]`, out));
    return out;
  }

  if (value !== null && typeof value === "object") {
    for (const [name, child] of Object.entries(value)) {
      maskedPathsIn(child, path ? `${path}.${name}` : name, out);
    }
  }

  return out;
}
