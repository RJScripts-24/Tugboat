import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as ts from "typescript";

import { GENESIS_HASH, chainHash, chainSha256, ledgerDigest, sha256Hex } from "./ledger-digest";

/**
 * The digest, checked against the copy the browser actually runs.
 *
 * A test that reimplemented FNV-1a here and compared would prove only that two
 * things this repository wrote agree with each other. So this compiles
 * `frontend/src/lib/ledger-digest.ts` — the real file, the one shipped to the
 * browser — and runs it side by side. If anybody edits either implementation,
 * every row in the ledger stops verifying in the UI, and this is the test that
 * says so before a panelist does.
 */

const FRONTEND_DIGEST = join(__dirname, "../../../frontend/src/lib/ledger-digest.ts");

function loadBrowserDigest(): (seed: string, length?: number) => string {
  const source = readFileSync(FRONTEND_DIGEST, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });

  const module = { exports: {} as Record<string, unknown> };
  new Function("exports", "module", outputText)(module.exports, module);

  const fn = module.exports.ledgerDigest;
  if (typeof fn !== "function") {
    throw new Error(`${FRONTEND_DIGEST} no longer exports ledgerDigest`);
  }

  return fn as (seed: string, length?: number) => string;
}

/** Inputs chosen to exercise the mixing, not just the happy path. */
const SEEDS = [
  "",
  "a",
  "C-1188|3|1756123456789|BOA|ACTION_EXECUTED|C-1188|WhatsApp nudge sent|0a1b2c3d4e5f6071",
  "policy|1|1756123456789|HUMAN|POLICY_CHANGED|-|v4 → v5 · one field moved|deadbeefdeadbeef",
  "₹4,800 · Namaste 👋 बंद करो",
  "|".repeat(64),
  "x".repeat(4096),
  "0".repeat(10),
  JSON.stringify({ nested: { deeply: [1, 2, 3, null, true] } }),
];

describe("ledgerDigest — parity with the browser's copy", () => {
  const browserDigest = loadBrowserDigest();

  it.each(SEEDS)("agrees on %#", (seed) => {
    expect(ledgerDigest(seed)).toBe(browserDigest(seed));
  });

  it("agrees at every length the ledger uses", () => {
    for (const length of [8, 10, 16, 32, 64]) {
      expect(ledgerDigest(SEEDS[2], length)).toBe(browserDigest(SEEDS[2], length));
    }
  });

  it("agrees on the chained construction the row actually stores", () => {
    let prev = GENESIS_HASH;
    for (const seed of SEEDS) {
      const ours = chainHash(seed, prev);
      expect(ours).toBe(browserDigest(`${seed}|${prev}`));
      prev = ours;
    }
  });
});

describe("ledgerDigest — shape", () => {
  it("is ten lowercase hex characters by default", () => {
    expect(ledgerDigest("anything")).toMatch(/^[0-9a-f]{10}$/);
  });

  it("returns exactly the length asked for", () => {
    for (const length of [1, 5, 10, 16, 33, 64]) {
      expect(ledgerDigest("anything", length)).toHaveLength(length);
    }
  });

  it("is deterministic — the same seed always gives the same digest", () => {
    expect(ledgerDigest(SEEDS[2])).toBe(ledgerDigest(SEEDS[2]));
  });

  it("changes completely when one character of the seed changes", () => {
    const a = ledgerDigest("C-1188|3|BOA|sent");
    const b = ledgerDigest("C-1188|4|BOA|sent");

    expect(a).not.toBe(b);
    // Not a strength claim — a ten-character FNV digest has no such claim to
    // make. It is the avalanche property that makes an edit *visible*.
    const shared = [...a].filter((char, i) => char === b[i]).length;
    expect(shared).toBeLessThan(a.length);
  });

  it("does not collide across the seeds this ledger actually writes", () => {
    const digests = SEEDS.map((seed) => ledgerDigest(seed));
    expect(new Set(digests).size).toBe(SEEDS.length);
  });
});

describe("sha256Hex — the server's parallel chain", () => {
  it("is a full 64-character digest", () => {
    expect(sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the published vector for the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("chains from its own genesis, not the browser chain's", () => {
    // The two chains cover the same preimage but never share a link: mixing
    // them would make one chain's break depend on the other's.
    expect(chainSha256("seed", "0".repeat(64))).not.toBe(chainHash("seed", GENESIS_HASH));
  });

  it("treats UTF-8 as UTF-8, so a rupee sign is not a question mark", () => {
    expect(sha256Hex("₹4,800")).not.toBe(sha256Hex("?4,800"));
  });
});
