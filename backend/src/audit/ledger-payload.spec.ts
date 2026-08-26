import type { Case, CaseEvent, Customer, EventKind } from "@prisma/client";

import { maskedPathsIn } from "./ledger-seed";
import { AUDIT_MAP, payloadFor } from "./ledger-payload";

const EVENT_KINDS: EventKind[] = [
  "DETECTED",
  "DIAGNOSED",
  "PLANNED",
  "POLICY_CHECK",
  "EMAIL_SENT",
  "WHATSAPP_SENT",
  "VOICE_CALL",
  "RETRY_EXECUTED",
  "CUSTOMER_REPLY",
  "PROMISE_RECORDED",
  "ESCALATED",
  "APPROVAL_DECIDED",
  "HALTED",
  "RECOVERED",
];

const REAL_PHONE = "+919822010210";
const REAL_EMAIL = "ananya@example.test";

const customer = {
  id: "cus_1",
  merchantId: "m1",
  name: "Ananya Sharma",
  email: REAL_EMAIL,
  phone: REAL_PHONE,
  maskedEmail: "a•••••@example.test",
  maskedPhone: "98•••••210",
  languagePref: "en-IN",
  segment: "B2C",
  optedOutAt: null,
  personaJson: null,
  createdAt: new Date(),
} as unknown as Customer;

const record = {
  id: 1188,
  merchantId: "m1",
  customerId: "cus_1",
  type: "PAYMENT_FAILED",
  amountPaise: 480_000,
  currency: "INR",
  stage: "waiting",
  rootCause: "INSUFFICIENT_FUNDS",
  diagnosisConfidence: 0.96,
  diagnosisMethod: "RULES",
  diagnosisRuleId: "R-03",
  originKind: "Razorpay payment",
  originId: "pay_QkT2mB9xLc41Za",
  instrument: "•••• •••• •••• 4821",
  attemptsUsed: 2,
  attemptCap: 4,
  recoveredAmountPaise: 0,
} as unknown as Case;

function event(
  kind: EventKind,
  body: unknown = null,
): Pick<CaseEvent, "kind" | "title" | "summary" | "body"> {
  return {
    kind,
    title: `${kind} happened`,
    summary: `a one-line account of ${kind}`,
    body: body as CaseEvent["body"],
  };
}

describe("AUDIT_MAP", () => {
  it("names an actor and an action for every event kind", () => {
    // The ledger is written on the one path that must never throw. A kind with
    // no mapping would be a runtime failure inside the transaction that records
    // history.
    for (const kind of EVENT_KINDS) {
      expect(AUDIT_MAP[kind]).toBeDefined();
      expect(AUDIT_MAP[kind].action).toMatch(/^[A-Z_]+$/);
    }
  });

  it("matches the frontend's mapping for the rows a panelist will read", () => {
    expect(AUDIT_MAP.DETECTED).toEqual({ actor: "SYSTEM", action: "CASE_OPENED" });
    expect(AUDIT_MAP.POLICY_CHECK).toEqual({ actor: "POLICY", action: "POLICY_EVALUATED" });
    expect(AUDIT_MAP.APPROVAL_DECIDED).toEqual({ actor: "HUMAN", action: "APPROVAL_DECIDED" });
    expect(AUDIT_MAP.RECOVERED).toEqual({ actor: "SYSTEM", action: "PAYMENT_CAPTURED" });
  });

  it("attributes a send to the agent and a halt to the policy", () => {
    // Who did it is the question the Audit Explorer's actor filter answers, and
    // "the agent sent this" is a different claim from "the rules stopped this".
    expect(AUDIT_MAP.WHATSAPP_SENT.actor).toBe("BOA");
    expect(AUDIT_MAP.HALTED.actor).toBe("POLICY");
    expect(AUDIT_MAP.CUSTOMER_REPLY.actor).toBe("SYSTEM");
  });
});

describe("payloadFor — what every row carries", () => {
  it.each(EVENT_KINDS)("%s names the case it belongs to", (kind) => {
    const payload = payloadFor(event(kind), record, customer) as Record<string, unknown>;
    expect(payload.case_id).toBe("C-1188");
  });

  it.each(EVENT_KINDS)("%s never carries a real phone number or address", (kind) => {
    const body = {
      type: "message",
      lines: ["one", "two"],
      rows: [{ label: "To", value: "98•••••210" }],
      transcript: [{ speaker: "BOA", text: "hello" }],
    };
    const serialised = JSON.stringify(payloadFor(event(kind, body), record, customer));

    // Masking happens where data enters the system (PRD 9.9), so the ledger is
    // reading an already-masked value rather than redacting on the way out.
    expect(serialised).not.toContain(REAL_PHONE);
    expect(serialised).not.toContain(REAL_EMAIL);
  });
});

describe("payloadFor — decision records, not archives", () => {
  it("references a message body by shape rather than embedding it", () => {
    const body = {
      type: "message",
      subject: "Your ₹4,800 payment didn't complete",
      lines: ["Hello", "the link", "Reply STOP"],
      link: "rzp.io/l/tug-abc123",
      rows: [{ label: "To", value: "a•••••@example.test" }],
    };

    const payload = payloadFor(event("EMAIL_SENT", body), record, customer) as Record<
      string,
      unknown
    >;

    expect(payload.body_lines).toBe(3);
    expect(payload.payment_link).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("Reply STOP");
  });

  it("counts transcript turns rather than storing the call", () => {
    const body = {
      type: "voice",
      seconds: 47,
      intent: "PROMISED_TO_PAY",
      transcript: [
        { speaker: "BOA", text: "Namaste" },
        { speaker: "CUSTOMER", text: "haan" },
        { speaker: "BOA", text: "shukriya" },
      ],
    };

    const payload = payloadFor(event("VOICE_CALL", body), record, customer) as Record<
      string,
      unknown
    >;

    expect(payload.transcript_turns).toBe(3);
    expect(payload.detected_intent).toBe("PROMISED_TO_PAY");
    expect(JSON.stringify(payload)).not.toContain("Namaste");
  });

  it("records the recipient once, masked, and flags it as masked", () => {
    const body = { type: "message", lines: [], rows: [{ label: "To", value: "98•••••210" }] };
    const payload = payloadFor(event("WHATSAPP_SENT", body), record, customer);

    // "To" is dropped from the fact rows because `recipient` already holds it —
    // the same masked number under two names is one of them going unflagged.
    expect((payload as Record<string, unknown>).recipient).toBe("98•••••210");
    expect(maskedPathsIn(payload)).toEqual(["recipient"]);
  });

  it("keeps the gate's own checklist, which is the compliance evidence", () => {
    const body = {
      type: "policy",
      checks: [
        { name: "Quiet hours", verdict: "pass", note: "14:30 IST is inside the window" },
        { name: "Opt-out", verdict: "pass", note: "No opt-out on record" },
      ],
    };

    const payload = payloadFor(event("POLICY_CHECK", body), record, customer) as Record<
      string,
      unknown
    >;
    const checks = payload.checks as { name: string; verdict: string }[];

    expect(checks).toHaveLength(2);
    expect(checks[0].verdict).toBe("PASS");
  });

  it("distinguishes an approval from a pass and a block", () => {
    const asPass = payloadFor(
      { ...event("POLICY_CHECK"), title: "Policy check — 9/9 passed" },
      record,
      customer,
    ) as Record<string, unknown>;
    const asBlock = payloadFor(
      { ...event("POLICY_CHECK"), title: "Policy check — blocked" },
      record,
      customer,
    ) as Record<string, unknown>;
    const asApproval = payloadFor(
      { ...event("POLICY_CHECK"), title: "Policy check — needs approval" },
      record,
      customer,
    ) as Record<string, unknown>;

    // Collapsing the third into either of the others would make the evidence
    // report's escalation count unrecoverable from the ledger.
    expect(asPass.verdict).toBe("PASS");
    expect(asBlock.verdict).toBe("BLOCK");
    expect(asApproval.verdict).toBe("NEEDS_APPROVAL");
  });

  it("carries the planner's rejected alternatives, not only its choice", () => {
    const body = {
      type: "plan",
      chosen: "WhatsApp nudge",
      because: "the customer reads WhatsApp",
      rejected: [{ option: "Voice", reason: "cap already spent" }],
    };

    const payload = payloadFor(event("PLANNED", body), record, customer) as Record<string, unknown>;

    expect(payload.chosen).toBe("WhatsApp nudge");
    expect(payload.rejected).toHaveLength(1);
  });

  it("records the diagnosis with the rule that produced it", () => {
    const payload = payloadFor(event("DIAGNOSED"), record, customer) as Record<string, unknown>;

    expect(payload.root_cause).toBe("INSUFFICIENT_FUNDS");
    expect(payload.method).toBe("RULES");
    expect(payload.rule_id).toBe("R-03");
  });

  it("says a retry contacted nobody", () => {
    const payload = payloadFor(event("RETRY_EXECUTED"), record, customer) as Record<
      string,
      unknown
    >;

    expect(payload.silent).toBe(true);
    expect(payload.channel).toBe("RETRY");
  });

  it("says a halt is not reversible, because it is not", () => {
    const payload = payloadFor(event("HALTED"), record, customer) as Record<string, unknown>;

    expect(payload.reversible).toBe(false);
    expect(payload.scope).toBe("ALL_CHANNELS");
  });

  it("survives an event whose body was never written", () => {
    for (const kind of EVENT_KINDS) {
      expect(() => payloadFor(event(kind, null), record, customer)).not.toThrow();
    }
  });
});
