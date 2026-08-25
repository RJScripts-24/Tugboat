import type { ApprovalGateName } from "./ask-builder";

/**
 * Why a merchant says no, per gate.
 *
 * Gate-specific because a generic list produces nonsense: "margin is already
 * thin" is not a reason to refuse a hardship stand-down, and an approver
 * offered it would stop reading the options. Served on every pending request so
 * the dialog's choices and the reasons the history table can contain are one
 * list rather than two that drift (D-70).
 *
 * A free-typed reason is still accepted — the list is a prompt, not a schema.
 * Refusing an approver's own words would push them toward whichever canned
 * option was closest, and a reason nobody meant teaches the planner nothing.
 */
const REJECTION_REASONS: Record<ApprovalGateName, readonly string[]> = {
  discount_requires_approval: [
    "Margin is already thin on this line — no discount",
    "This account took a concession last quarter",
    "The amount does not justify giving anything away",
    "Chase it once more, but without a discount",
  ],
  b2b_high_value: [
    "Sales owns this account — they will handle it",
    "Payment is already scheduled · do not chase",
    "This one goes out from our inbox, not the agent's",
  ],
  confidence_below_threshold: [
    "Route to manual review rather than another automated attempt",
    "The guess is wrong — this is not what failed",
    "Too small to spend another attempt on",
  ],
  hardship_language: [
    "No payment plan on this account — close it instead",
    "Collections will take this one from here",
    "The terms are wrong · I will make the offer myself",
  ],
};

export function rejectionReasonsFor(gate: ApprovalGateName): string[] {
  return [...REJECTION_REASONS[gate]];
}
