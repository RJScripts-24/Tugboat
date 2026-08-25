import type { PolicyChannel } from "./policy-pack";

declare const gatePassBrand: unique symbol;

/**
 * Proof that a specific action was cleared by the PolicyGate.
 *
 * The brand is declared and never defined, so no value of this type can be
 * constructed anywhere — the gate mints one with an explicit cast, and that
 * cast is the single greppable place it can happen (asserted by
 * `architecture.spec.ts`). Channel adapters take a pass as their first
 * argument, which turns "nothing reaches a customer without a verdict" from a
 * convention into a compile error.
 */
export type GatePass = {
  readonly [gatePassBrand]: true;
  readonly decisionId: string;
  readonly caseId: number;
  readonly channel: PolicyChannel;
  readonly policyVersion: string;
  readonly issuedAt: Date;
};

export type GatePassClaims = Omit<GatePass, typeof gatePassBrand>;
