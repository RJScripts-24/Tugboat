import { createHash } from "node:crypto";

/**
 * The ledger's two digests.
 *
 * `ledgerDigest` is a character-for-character port of
 * `frontend/src/lib/ledger-digest.ts`. It is deliberately the *weak* one — FNV-1a
 * with a widening mix, ten hex characters, not cryptographic and not pretending
 * to be. Its job is not strength; its job is that the person being asked to
 * trust this log can recompute every digest in their own browser, from the same
 * inputs they were handed, without a server telling them the answer. A hash the
 * reader cannot recompute proves nothing to the reader.
 *
 * `sha256Hex` is the strong one, kept on a parallel chain over the same
 * preimage. It is collision- and preimage-resistant, and believing it means
 * believing this server computed it — which is exactly the property the first
 * one does not need. Neither digest alone is the honest answer; the pair is
 * (D-73).
 *
 * Nothing here may be "improved" independently of the frontend file: two
 * implementations of a digest that disagree turn every row into a failure.
 */

/** FNV-1a plus a widening mix. Must stay identical to the browser's copy. */
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

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** The link the first row of every chain names. Ten zeroes, per the contract. */
export const GENESIS_HASH = "0".repeat(10);

/** The strong chain's genesis, sized to its own digest. */
export const GENESIS_SHA256 = "0".repeat(64);

/** `hash = digest(seed | prevHash)` — the construction the browser repeats. */
export function chainHash(seed: string, prevHash: string): string {
  return ledgerDigest(`${seed}|${prevHash}`);
}

export function chainSha256(seed: string, prevSha256: string): string {
  return sha256Hex(`${seed}|${prevSha256}`);
}
