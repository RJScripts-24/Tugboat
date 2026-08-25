import type { ApprovalGateName } from "./ask-builder";
import { rejectionReasonsFor } from "./rejection-reasons";

const GATES: ApprovalGateName[] = [
  "discount_requires_approval",
  "b2b_high_value",
  "confidence_below_threshold",
  "hardship_language",
];

describe("Rejection reasons", () => {
  it.each(GATES)("%s offers at least three usable reasons", (gate) => {
    const reasons = rejectionReasonsFor(gate);

    expect(reasons.length).toBeGreaterThanOrEqual(3);
    expect(reasons.every((reason) => reason.length > 15)).toBe(true);
  });

  it("gives each gate its own list", () => {
    const lists = GATES.map((gate) => rejectionReasonsFor(gate).join("|"));
    expect(new Set(lists).size).toBe(GATES.length);
  });

  it("never offers a margin argument against a hardship stand-down", () => {
    // A generic list produces nonsense here, and an approver handed nonsense
    // stops reading the options — which is how a reason nobody meant ends up in
    // the evidence report.
    const reasons = rejectionReasonsFor("hardship_language").join(" ").toLowerCase();

    expect(reasons).not.toContain("margin");
    expect(reasons).not.toContain("discount");
  });

  it("hands back a copy, so a caller cannot edit the table through it", () => {
    const first = rejectionReasonsFor("b2b_high_value");
    first.push("something a merchant never said");

    expect(rejectionReasonsFor("b2b_high_value")).not.toContain("something a merchant never said");
  });
});
