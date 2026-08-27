import type { Case } from "@prisma/client";

import { ladderFor, openingDelayMs } from "./playbooks";
import { NoPlanAvailableError, PlannerService, planProposalSchema } from "./planner.service";

const planner = new PlannerService();

function caseRecord(overrides: Partial<Case> = {}): Case {
  return {
    id: 1001,
    merchantId: "m1",
    customerId: "c1",
    type: "PAYMENT_FAILED",
    amountPaise: 480_000,
    currency: "INR",
    stage: "diagnosed",
    rootCause: "INSUFFICIENT_FUNDS",
    diagnosisConfidence: 0.96,
    diagnosisMethod: "RULES",
    diagnosisRuleId: "R-03",
    diagnosisAt: new Date(),
    failureCode: null,
    failureReason: null,
    failureSource: null,
    instrument: null,
    degradationIncidentId: null,
    lastSentiment: null,
    lastSentimentScore: null,
    hardshipFlaggedAt: null,
    originKind: null,
    originId: null,
    originRef: null,
    deadlineAt: null,
    attemptsUsed: 0,
    attemptCap: 4,
    recoveredAmountPaise: 0,
    costPaise: 0,
    simRunId: null,
    simArm: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Case;
}

describe("the playbook ladders", () => {
  it("puts the free move first when the bank is the problem", () => {
    // A gateway outage is not the customer's fault and not their fix. Messaging
    // them about it is both useless and, per PRD 9, anti-compliance.
    expect(ladderFor("PAYMENT_FAILED", "BANK_GATEWAY_DEGRADED")[0]).toBe("RETRY");
  });

  it("never opens a ladder with a phone call", () => {
    const causes = [
      "BANK_GATEWAY_DEGRADED",
      "INSUFFICIENT_FUNDS",
      "CUSTOMER_DISTRACTED",
      "CARD_EXPIRED",
      "MANDATE_REVOKED",
      "UNKNOWN",
    ] as const;
    const types = [
      "PAYMENT_FAILED",
      "CHECKOUT_ABANDONED",
      "MANDATE_FAILED",
      "INVOICE_OVERDUE",
    ] as const;

    for (const type of types) {
      for (const cause of causes) {
        expect(ladderFor(type, cause)[0]).not.toBe("VOICE");
      }
    }
  });

  it("never asks for a voice call more than once, matching the cap of one", () => {
    const ladders = (["PAYMENT_FAILED", "CHECKOUT_ABANDONED", "MANDATE_FAILED", "INVOICE_OVERDUE"] as const).flatMap(
      (type) =>
        (["INSUFFICIENT_FUNDS", "CARD_EXPIRED", "MANDATE_REVOKED", "UNKNOWN"] as const).map((cause) =>
          ladderFor(type, cause),
        ),
    );

    for (const ladder of ladders) {
      expect(ladder.filter((channel) => channel === "VOICE").length).toBeLessThanOrEqual(1);
    }
  });

  it("does not try to re-present a mandate the customer revoked", () => {
    // There is nothing left to charge against; the ladder is about getting it
    // re-authorised, so a retry would be a guaranteed failure and a spent attempt.
    expect(ladderFor("MANDATE_FAILED", "MANDATE_REVOKED")).not.toContain("RETRY");
    expect(ladderFor("MANDATE_FAILED", "INSUFFICIENT_FUNDS")).toContain("RETRY");
  });

  it("settles invoices in writing before it calls", () => {
    expect(ladderFor("INVOICE_OVERDUE", "CUSTOMER_DISTRACTED").slice(0, 2)).toEqual([
      "EMAIL",
      "EMAIL",
    ]);
  });

  it("waits before nudging an abandoned checkout, and not otherwise", () => {
    expect(openingDelayMs("CHECKOUT_ABANDONED", "CUSTOMER_DISTRACTED")).toBe(45 * 60_000);
    expect(openingDelayMs("PAYMENT_FAILED", "INSUFFICIENT_FUNDS")).toBe(0);
    expect(openingDelayMs("PAYMENT_FAILED", "BANK_GATEWAY_DEGRADED")).toBeGreaterThan(0);
  });
});

describe("the planner", () => {
  it("produces a schema-valid proposal with its rejected alternatives", () => {
    const plan = planner.propose(caseRecord());

    expect(planProposalSchema.safeParse(plan).success).toBe(true);
    expect(plan.channel).toBe("WHATSAPP");
    expect(plan.attempt).toBe(1);
    expect(plan.source).toBe("playbook");
    // The rejected list is the half that makes a plan auditable rather than
    // merely logged.
    expect(plan.rejected.length).toBeGreaterThan(0);
    expect(plan.because.length).toBeGreaterThan(20);
  });

  it("walks the ladder as attempts are spent", () => {
    expect(planner.propose(caseRecord({ attemptsUsed: 0 })).channel).toBe("WHATSAPP");
    expect(planner.propose(caseRecord({ attemptsUsed: 1 })).channel).toBe("RETRY");
    expect(planner.propose(caseRecord({ attemptsUsed: 2 })).channel).toBe("VOICE");
    expect(planner.propose(caseRecord({ attemptsUsed: 3 })).channel).toBe("EMAIL");
  });

  it("tells the truth about a customer with no phone: email is the first open channel", () => {
    const plan = planner.propose(caseRecord({ type: "PAYMENT_FAILED", rootCause: "CARD_EXPIRED" }), {
      exclude: ["WHATSAPP", "VOICE"],
      unreachable: ["WHATSAPP", "VOICE"],
    });

    expect(plan.channel).toBe("EMAIL");
    expect(plan.because).toMatch(/no phone number on file/i);
    expect(plan.because).not.toMatch(/last contact was on WhatsApp/);
    expect(plan.rejected[0]).toMatchObject({ option: "WhatsApp", reason: expect.stringMatching(/no phone/i) });
  });

  it("steps past a channel the gate has already refused", () => {
    const plan = planner.propose(caseRecord(), { exclude: ["WHATSAPP"] });
    expect(plan.channel).toBe("RETRY");

    const next = planner.propose(caseRecord(), { exclude: ["WHATSAPP", "RETRY"] });
    expect(next.channel).toBe("VOICE");
  });

  it("gives up rather than inventing a channel when every rung is refused", () => {
    expect(() =>
      planner.propose(caseRecord(), { exclude: ["WHATSAPP", "RETRY", "VOICE", "EMAIL"] }),
    ).toThrow(NoPlanAvailableError);
  });

  it("only carries an opening delay on the first attempt", () => {
    const abandoned = caseRecord({ type: "CHECKOUT_ABANDONED", rootCause: "CUSTOMER_DISTRACTED" });

    expect(planner.propose(abandoned).delayMs).toBe(45 * 60_000);
    expect(planner.propose({ ...abandoned, attemptsUsed: 1 }).delayMs).toBe(0);
  });

  it("explains a retry differently when a degradation is what caused the failure", () => {
    const degraded = planner.propose(
      caseRecord({ rootCause: "BANK_GATEWAY_DEGRADED" }),
      { degraded: true },
    );
    expect(degraded.because).toContain("nothing to do with the customer");
  });
});

describe("the voice rung tells the truth about what came before it (B-69) and honours a human's ask (D-145)", () => {
  const planner = new PlannerService();

  it("narrates a first-contact call as a first contact when no written channel can reach the customer", () => {
    const plan = planner.propose(
      caseRecord({ type: "INVOICE_OVERDUE", rootCause: "CUSTOMER_DISTRACTED", attemptsUsed: 0 }),
      { exclude: ["EMAIL", "WHATSAPP"], unreachable: ["EMAIL", "WHATSAPP"] },
    );

    expect(plan.channel).toBe("VOICE");
    expect(plan.because).toMatch(/first contact/i);
    expect(plan.because).not.toMatch(/two written nudges/i);
    expect(plan.rejected[0]).toMatchObject({ reason: expect.stringMatching(/no email or phone number on file/i) });
  });

  it("counts the written nudges that actually preceded the call", () => {
    const one = planner.propose(
      caseRecord({ type: "INVOICE_OVERDUE", rootCause: "CUSTOMER_DISTRACTED", attemptsUsed: 1 }),
      { exclude: ["EMAIL"] },
    );
    expect(one.channel).toBe("VOICE");
    expect(one.because).toMatch(/one written nudge/i);

    const two = planner.propose(
      caseRecord({ type: "INVOICE_OVERDUE", rootCause: "CUSTOMER_DISTRACTED", attemptsUsed: 2 }),
    );
    expect(two.channel).toBe("VOICE");
    expect(two.because).toMatch(/two written nudges/i);
  });

  it("plans the rung a human asked for, unless it has been refused this pass", () => {
    expect(planner.propose(caseRecord({ attemptsUsed: 0 }), { channel: "VOICE" }).channel).toBe("VOICE");
    expect(planner.propose(caseRecord({ attemptsUsed: 0 }), { channel: "VOICE", exclude: ["VOICE"] }).channel).toBe("WHATSAPP");
  });
});
