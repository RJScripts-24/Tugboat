import { GENESIS_HASH, GENESIS_SHA256, chainHash, chainSha256 } from "./ledger-digest";
import type { PayloadValue } from "./ledger-seed";
import { chainsOf, rebuildSeed, verifyChainRows, type VerifiableRow } from "./verify-chain";

/**
 * The Stage 7 Definition of Done, without a database.
 *
 * Tampering with any historical row must break verification *at exactly that
 * row*, and every row after it must fail with it. Both halves matter: a chain
 * that fails everywhere names no culprit, and a chain that fails only at the
 * edited row is not a chain at all.
 */

const START = new Date("2026-08-26T09:00:00.000Z").getTime();

type Draft = {
  actor?: VerifiableRow["actor"];
  action?: string;
  detail?: string;
  payload?: PayloadValue;
};

/** Builds a genuine, correctly chained ledger — the thing the tests then break. */
function buildChain(
  chain: string,
  drafts: Draft[],
  caseRef: string | null = chain,
): VerifiableRow[] {
  const rows: VerifiableRow[] = [];
  let prevHash = GENESIS_HASH;
  let prevSha256 = GENESIS_SHA256;

  drafts.forEach((draft, index) => {
    const partial: VerifiableRow = {
      chain,
      seq: index + 1,
      hash: "",
      prevHash,
      sha256: "",
      prevSha256,
      seed: "",
      actor: draft.actor ?? "BOA",
      action: draft.action ?? "ACTION_EXECUTED",
      at: new Date(START + index * 60_000),
      detail: draft.detail ?? `step ${index + 1}`,
      caseRef,
      payload: draft.payload ?? { case_id: caseRef, step: index + 1 },
    };

    partial.seed = rebuildSeed(partial);
    partial.hash = chainHash(partial.seed, prevHash);
    partial.sha256 = chainSha256(partial.seed, prevSha256);

    prevHash = partial.hash;
    prevSha256 = partial.sha256;
    rows.push(partial);
  });

  return rows;
}

const CHAIN = "C-1188";

function honest(): VerifiableRow[] {
  return buildChain(CHAIN, [
    { actor: "SYSTEM", action: "CASE_OPENED", detail: "Payment failed" },
    { action: "DIAGNOSIS_WRITTEN", detail: "Insufficient funds · 0.96" },
    { actor: "POLICY", action: "POLICY_EVALUATED", detail: "9/9 passed" },
    { action: "ACTION_EXECUTED", detail: "WhatsApp nudge sent" },
    { actor: "SYSTEM", action: "PAYMENT_CAPTURED", detail: "Recovered ₹4,800" },
  ]);
}

describe("A chain that has not been touched", () => {
  it("verifies", () => {
    expect(verifyChainRows(CHAIN, honest())).toEqual([]);
  });

  it("verifies one row on its own", () => {
    expect(verifyChainRows(CHAIN, honest().slice(0, 1))).toEqual([]);
  });

  it("verifies an empty chain rather than throwing", () => {
    expect(verifyChainRows(CHAIN, [])).toEqual([]);
  });
});

describe("An edited payload", () => {
  it("breaks at exactly the row that was edited", () => {
    const rows = honest();
    rows[2].payload = { case_id: CHAIN, step: 3, verdict: "PASS-ish" };

    const broken = verifyChainRows(CHAIN, rows);

    expect(broken[0]).toMatchObject({ id: `${CHAIN}#3`, seq: 3 });
    expect(broken[0].reason).toContain("no longer produces its own preimage");
  });

  it("takes every row after it down as well", () => {
    const rows = honest();
    rows[1].payload = { case_id: CHAIN, step: 2, tampered: true };

    const broken = verifyChainRows(CHAIN, rows);

    // Rows 2, 3, 4 and 5 — the edit and the cascade. Row 1 is untouched.
    expect(broken.map((entry) => entry.seq)).toEqual([2, 3, 4, 5]);
    expect(broken.some((entry) => entry.seq === 1)).toBe(false);
  });

  it("names the cascade differently from the edit itself", () => {
    const rows = honest();
    rows[1].detail = "something else entirely";

    const broken = verifyChainRows(CHAIN, rows);

    expect(broken[0].reason).toContain("no longer produces its own preimage");
    expect(broken[1].reason).toContain("chained to a digest that changed");
  });

  it("is caught even when the seed was rewritten to match", () => {
    // The naive tamper is editing the payload alone. The careful one edits the
    // preimage too — and still fails, because the digest beside it was computed
    // from the old preimage. Only rewriting every row after it would hide this,
    // which is the whole point of a chain (D-74).
    const rows = honest();
    rows[3].payload = { case_id: CHAIN, step: 4, channel: "EMAIL" };
    rows[3].seed = rebuildSeed(rows[3]);

    const broken = verifyChainRows(CHAIN, rows);

    expect(broken[0].seq).toBe(4);
    expect(broken[0].reason).toContain("no longer hashes to its stored digest");
  });
});

describe("A removed or reordered row", () => {
  it("breaks the link at the row that now points at the wrong digest", () => {
    const rows = honest();
    rows.splice(2, 1);

    const broken = verifyChainRows(CHAIN, rows);

    expect(broken[0].seq).toBe(4);
    expect(broken[0].reason).toContain("link broken");
  });

  it("breaks when two rows are swapped", () => {
    const rows = honest();
    [rows[1], rows[2]] = [rows[2], rows[1]];

    expect(verifyChainRows(CHAIN, rows).length).toBeGreaterThan(0);
  });

  it("does not mind a chain being verified from its genesis alone", () => {
    // The first row names ten zeroes and there is nothing before it to disagree.
    const rows = honest().slice(0, 1);
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    expect(verifyChainRows(CHAIN, rows)).toEqual([]);
  });
});

describe("A forged chain", () => {
  it("does not verify just because its rows agree with each other", () => {
    // Every row's prevHash names its neighbour's hash, so a verifier that
    // trusted the stored links would pass this happily. The digests are
    // invented, and recomputing is what catches it.
    const rows = honest().map((row, index) => ({
      ...row,
      hash: `ffffffff0${index}`,
      prevHash: index === 0 ? GENESIS_HASH : `ffffffff0${index - 1}`,
    }));

    const broken = verifyChainRows(CHAIN, rows);

    expect(broken.length).toBe(rows.length);
    expect(broken[0].seq).toBe(1);
  });

  it("catches a rewritten digest even when the weak one was recomputed correctly", () => {
    // Someone who ported the browser's ten-character digest and re-signed a row
    // still has to produce a SHA-256 over the same preimage.
    const rows = honest();
    rows[2].payload = { case_id: CHAIN, step: 3, quietly: "changed" };
    rows[2].seed = rebuildSeed(rows[2]);
    rows[2].hash = chainHash(rows[2].seed, rows[2].prevHash);

    const broken = verifyChainRows(CHAIN, rows);

    expect(broken.map((entry) => entry.seq)).toContain(3);
  });

  it("reports a row once, however many digests noticed it", () => {
    const rows = honest();
    rows[2].payload = { tampered: true };

    const broken = verifyChainRows(CHAIN, rows);
    const ids = broken.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("chainsOf", () => {
  it("keeps chains apart, so one case's break is not another's", () => {
    const rows = [...honest(), ...buildChain("C-2000", [{ detail: "opened" }], "C-2000")];
    const chains = chainsOf(rows);

    expect([...chains.keys()].sort()).toEqual(["C-1188", "C-2000"]);
    expect(chains.get("C-2000")).toHaveLength(1);
  });

  it("sorts each chain oldest first, whatever order the rows arrived in", () => {
    const rows = [...honest()].reverse();
    const chain = chainsOf(rows).get(CHAIN)!;

    expect(chain.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(verifyChainRows(CHAIN, chain)).toEqual([]);
  });

  it("handles the policy chain, which belongs to no case", () => {
    const rows = buildChain(
      "policy",
      [
        { actor: "HUMAN", action: "POLICY_CHANGED", detail: "v3 → v4" },
        { actor: "HUMAN", action: "POLICY_CHANGED", detail: "v4 → v5" },
      ],
      null,
    );

    expect(verifyChainRows("policy", rows)).toEqual([]);
    expect(rows[0].caseRef).toBeNull();
  });
});
