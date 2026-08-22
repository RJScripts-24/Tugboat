/**
 * The ledger's digest, on its own.
 *
 * One function, in one file, imported by whoever writes a row and by whoever
 * checks it. A verifier running its own second implementation of the digest
 * verifies nothing - it only proves the two implementations agree with each
 * other, which they would even if both were wrong.
 *
 * It lives apart from `case-detail-data` so the browser can pull the verifier
 * without pulling two thousand lines of case builder along with it: the Audit
 * Explorer recomputes every hash on the client, and that is the whole point of
 * recomputing them.
 *
 * FNV-1a, then a widening mix. Not a cryptographic hash and not pretending to
 * be one - the real ledger writes SHA-256 server-side (PRD 7.2). What this
 * reproduces faithfully is the *structure*: each row's digest covers its own
 * payload and the digest before it, so a row cannot be altered or removed
 * without every row after it failing.
 */
export function ledgerDigest(seed: string, length = 10): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = "";
  while (out.length < length) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}
