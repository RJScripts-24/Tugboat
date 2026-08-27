import type { GatePass, GatePassClaims } from "../src/policy/gate-pass";

/**
 * A pass for tests that exercise an adapter directly.
 *
 * The one cast outside the gate, and it lives outside `src/` on purpose: the
 * architecture suite walks the application tree and asserts the gate is the
 * only minter there, which remains true. A unit test for a channel adapter has
 * to hand it *something*, and constructing the claims here is more honest than
 * routing every adapter test through a live PolicyGate and a database.
 */
export function testPass(claims: Partial<GatePassClaims> = {}): GatePass {
  const full: GatePassClaims = {
    decisionId: "decision_test",
    caseId: 1042,
    channel: "EMAIL",
    policyVersion: "v4",
    issuedAt: new Date("2026-08-27T09:00:00.000Z"),
    ...claims,
  };
  return full as GatePass;
}
