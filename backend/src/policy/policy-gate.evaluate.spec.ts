import { istMinuteOfDay } from "./ist-clock";
import {
  evaluateGate,
  type GateAction,
  type GateSubject,
  type PolicyCheck,
} from "./policy-gate.evaluate";
import type { PolicyPack } from "./policy-pack";

const RUPEE = 100;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Policy v4 — the pack the seeded batch is worked under. */
const V4: PolicyPack = {
  contact: { maxAttempts: 4, coolDownHours: 20, channelCaps: { WHATSAPP: 2, EMAIL: 2, VOICE: 1, RETRY: 2 } },
  quiet: { startMinutes: 21 * 60, endMinutes: 9 * 60, exemptSilentRetries: true },
  rules: { opt_out: true, sentiment: true, deadline: true, attempt_cap: true },
  sentimentThreshold: 0.7,
  escalation: {
    discountCapPercent: 15,
    valueThresholdPaise: 25_000 * RUPEE,
    b2bAlways: true,
    confidenceFloor: 0.6,
    hardship: true,
  },
  mandate: { maxPerCycle: 3, spacingDays: 3, alignToPayday: true },
  channels: { WHATSAPP: true, EMAIL: true, VOICE: true, RETRY: true },
};

/** 14:30 IST — comfortably inside the contactable window. */
const MIDDAY = new Date("2026-08-24T09:00:00.000Z");
/** 22:30 IST — inside quiet hours. */
const NIGHT = new Date("2026-08-24T17:00:00.000Z");

function subject(overrides: Partial<GateSubject> = {}): GateSubject {
  return {
    caseId: 1001,
    type: "PAYMENT_FAILED",
    amountPaise: 4_800 * RUPEE,
    clearedGates: [],
    attemptsUsed: 0,
    deadlineAt: new Date("2026-09-30T00:00:00.000Z"),
    diagnosisConfidence: 0.96,
    segment: "B2C",
    optedOutAt: null,
    pausedAt: null,
    lastSentiment: null,
    lastSentimentScore: null,
    hardshipFlaggedAt: null,
    channelUsage: { WHATSAPP: 0, EMAIL: 0, VOICE: 0, RETRY: 0 },
    lastContactAt: null,
    lastRepresentationAt: null,
    representationsThisCycle: 0,
    ...overrides,
  };
}

function action(overrides: Partial<GateAction> = {}): GateAction {
  return { channel: "WHATSAPP", at: MIDDAY, ...overrides };
}

function pack(overrides: (base: PolicyPack) => PolicyPack = (base) => base): PolicyPack {
  return overrides(structuredClone(V4));
}

function find(checks: PolicyCheck[], name: string): PolicyCheck {
  const hit = checks.find((check) => check.name === name);
  if (!hit) throw new Error(`No check named "${name}" in [${checks.map((c) => c.name).join(", ")}]`);
  return hit;
}

const run = (s: GateSubject, a: GateAction, p: PolicyPack = V4) => evaluateGate(s, a, p, "v4");

describe("PolicyGate — the clean path", () => {
  it("allows a well-behaved contact and reports every check", () => {
    const result = run(subject(), action());

    expect(result.verdict).toBe("allowed");
    expect(result.outcome).toEqual({ kind: "allow" });
    expect(result.terminalStage).toBeNull();
    expect(result.rescheduledFor).toBeNull();
    expect(result.gate).toBeNull();
    expect(result.checks.map((check) => check.name)).toEqual([
      "Quiet hours",
      "Attempt cap",
      "Channel cap",
      "Cool-down",
      "Opt-out",
      "Human override",
      "Sentiment halt",
      "Escalation gate",
      "Channel enabled",
      "Deadline",
    ]);
    expect(result.checks.every((check) => check.verdict === "pass")).toBe(true);
  });

  it("evaluates every check even after one has already failed", () => {
    // Not short-circuiting is the point: the Case Detail timeline shows the
    // full list, and "blocked at the first no" would hide the other bounds.
    const result = run(subject({ optedOutAt: new Date(), attemptsUsed: 9 }), action());

    expect(result.checks).toHaveLength(10);
    expect(find(result.checks, "Opt-out").verdict).toBe("block");
    expect(find(result.checks, "Attempt cap").verdict).toBe("block");
  });
});

describe("PolicyGate — the manual pause", () => {
  it("refuses every action while a merchant is holding the case", () => {
    const result = run(subject({ pausedAt: new Date() }), action());

    expect(result.verdict).toBe("blocked");
    expect(result.outcome.kind).toBe("refuse");
    // A refusal, not a halt: the case keeps its stage and a resume undoes it.
    expect(result.terminalStage).toBeNull();
    expect(find(result.checks, "Human override").verdict).toBe("block");
  });

  it("lets the customer's own STOP be the reason a paused case is blocked", () => {
    // Both are true; the timeline should say the opt-out stopped this, because
    // that is the one a merchant cannot take back.
    const result = run(subject({ pausedAt: new Date(), optedOutAt: new Date() }), action());

    expect(result.outcome.kind).toBe("halt");
    expect(result.terminalStage).toBe("halted");
  });

  it("gets out of the way as soon as the case is resumed", () => {
    const result = run(subject({ pausedAt: null }), action());

    expect(result.verdict).toBe("allowed");
    expect(find(result.checks, "Human override").verdict).toBe("pass");
  });
});

describe("PolicyGate — quiet hours", () => {
  it("passes inside the contactable window", () => {
    const result = run(subject(), action());
    expect(find(result.checks, "Quiet hours")).toEqual({
      name: "Quiet hours",
      verdict: "pass",
      note: "14:30 IST is inside the 09:00–21:00 window",
    });
  });

  it("blocks a night send and reschedules it to the window opening", () => {
    const result = run(subject(), action({ at: NIGHT }));

    expect(result.verdict).toBe("blocked");
    expect(result.outcome.kind).toBe("defer");
    expect(find(result.checks, "Quiet hours").note).toContain("rescheduled to 09:00");
    expect(result.rescheduledFor).not.toBeNull();
    expect(istMinuteOfDay(result.rescheduledFor as Date)).toBe(9 * 60);
    // Deferred, never dropped: the case keeps the contact.
    expect(result.terminalStage).toBeNull();
  });

  it("skips the check for a silent retry", () => {
    const result = run(subject(), action({ channel: "RETRY", at: NIGHT }));

    expect(find(result.checks, "Quiet hours")).toEqual({
      name: "Quiet hours",
      verdict: "skip",
      note: "Exempt — a silent retry contacts nobody",
    });
    expect(result.verdict).toBe("allowed");
  });

  it("holds a silent retry too when the exemption is switched off", () => {
    const strict = pack((base) => ({ ...base, quiet: { ...base.quiet, exemptSilentRetries: false } }));
    const result = run(subject(), action({ channel: "RETRY", at: NIGHT }), strict);

    expect(find(result.checks, "Quiet hours").verdict).toBe("block");
    expect(result.verdict).toBe("blocked");
  });
});

describe("PolicyGate — attempt and channel caps", () => {
  it("passes while attempts remain", () => {
    expect(find(run(subject({ attemptsUsed: 2 }), action()).checks, "Attempt cap").note).toBe(
      "3 of 4 used",
    );
  });

  it("exhausts the case when the cap is spent", () => {
    const result = run(subject({ attemptsUsed: 4 }), action());

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "exhaust" });
    expect(result.terminalStage).toBe("exhausted");
  });

  it("skips the cap when the stopping rule is switched off", () => {
    const loose = pack((base) => ({ ...base, rules: { ...base.rules, attempt_cap: false } }));
    const result = run(subject({ attemptsUsed: 9 }), action(), loose);

    expect(find(result.checks, "Attempt cap").verdict).toBe("skip");
    expect(result.verdict).toBe("allowed");
  });

  it("refuses a channel that is spent without closing the case", () => {
    const result = run(
      subject({ channelUsage: { WHATSAPP: 0, EMAIL: 0, VOICE: 1, RETRY: 0 } }),
      action({ channel: "VOICE" }),
    );

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "refuse" });
    // Another rung of the ladder may still be open, so the case survives.
    expect(result.terminalStage).toBeNull();
    expect(find(result.checks, "Channel cap").note).toContain("1 of 1 voice used");
  });
});

describe("PolicyGate — cool-down", () => {
  it("passes on the first contact", () => {
    expect(find(run(subject(), action()).checks, "Cool-down").note).toBe(
      "First contact on this case",
    );
  });

  it("defers a second contact inside the cool-down to the moment it expires", () => {
    const lastContactAt = new Date(MIDDAY.getTime() - 5 * HOUR);
    const result = run(subject({ lastContactAt }), action());

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "defer" });
    expect(result.rescheduledFor?.getTime()).toBe(lastContactAt.getTime() + 20 * HOUR);
    expect(find(result.checks, "Cool-down").note).toBe("5h since the last contact · minimum 20h");
  });

  it("passes once the cool-down has elapsed", () => {
    const result = run(subject({ lastContactAt: new Date(MIDDAY.getTime() - 21 * HOUR) }), action());
    expect(find(result.checks, "Cool-down").verdict).toBe("pass");
    expect(result.verdict).toBe("allowed");
  });

  it("exempts a silent retry", () => {
    const result = run(
      subject({ lastContactAt: new Date(MIDDAY.getTime() - 1 * HOUR) }),
      action({ channel: "RETRY" }),
    );
    expect(find(result.checks, "Cool-down").verdict).toBe("skip");
    expect(result.verdict).toBe("allowed");
  });
});

describe("PolicyGate — opt-out, the rule with no switch", () => {
  it("passes when nothing is on record", () => {
    expect(find(run(subject(), action()).checks, "Opt-out").note).toBe(
      "No opt-out on record for this customer",
    );
  });

  it("halts every channel once STOP is on record", () => {
    for (const channel of ["WHATSAPP", "EMAIL", "VOICE", "RETRY"] as const) {
      const result = run(subject({ optedOutAt: new Date() }), action({ channel }));
      expect(result.verdict).toBe("blocked");
      expect(result.outcome).toMatchObject({ kind: "halt" });
      expect(result.terminalStage).toBe("halted");
    }
  });

  it("treats an opt-out classification on the latest reply the same way", () => {
    const result = run(subject({ lastSentiment: "opt_out", lastSentimentScore: -1 }), action());
    expect(result.terminalStage).toBe("halted");
  });

  it("outranks an approval — no human may approve contacting an opted-out customer", () => {
    const result = run(
      subject({ optedOutAt: new Date(), segment: "B2B" }),
      action({ concessionPaise: 500 * RUPEE, discountPercent: 10 }),
    );

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "halt" });
    expect(result.gate).toBeNull();
  });
});

describe("PolicyGate — sentiment halt", () => {
  it("passes when there is nothing to classify", () => {
    expect(find(run(subject(), action()).checks, "Sentiment halt").note).toBe(
      "No reply to classify yet",
    );
  });

  it("halts on a strongly negative reply", () => {
    const result = run(
      subject({ lastSentiment: "negative", lastSentimentScore: -0.82 }),
      action(),
    );

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "halt" });
    expect(result.terminalStage).toBe("halted");
  });

  it("lets a mild grumble through — the threshold is what makes it a halt", () => {
    const result = run(subject({ lastSentiment: "negative", lastSentimentScore: -0.3 }), action());
    expect(find(result.checks, "Sentiment halt").verdict).toBe("pass");
    expect(result.verdict).toBe("allowed");
  });

  it("skips when the stopping rule is switched off", () => {
    const loose = pack((base) => ({ ...base, rules: { ...base.rules, sentiment: false } }));
    const result = run(
      subject({ lastSentiment: "negative", lastSentimentScore: -0.95 }),
      action(),
      loose,
    );

    expect(find(result.checks, "Sentiment halt").verdict).toBe("skip");
    expect(result.verdict).toBe("allowed");
  });
});

describe("PolicyGate — escalation gates", () => {
  it("passes a routine, discount-free contact", () => {
    expect(find(run(subject(), action()).checks, "Escalation gate").note).toBe(
      "₹4,800 is under the ₹25,000 approval threshold · no discount requested",
    );
  });

  it("sends any discount to a human", () => {
    const result = run(subject(), action({ concessionPaise: 480 * RUPEE, discountPercent: 10 }));

    expect(result.verdict).toBe("needs_approval");
    expect(result.gate).toBe("discount_requires_approval");
  });

  it("refuses a discount larger than any human here may approve", () => {
    const result = run(subject(), action({ concessionPaise: 1_920 * RUPEE, discountPercent: 40 }));

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "refuse" });
    expect(result.gate).toBeNull();
  });

  it("escalates above the value threshold", () => {
    const result = run(subject({ amountPaise: 30_000 * RUPEE }), action());

    expect(result.verdict).toBe("needs_approval");
    expect(result.gate).toBe("b2b_high_value");
  });

  it("escalates every B2B case", () => {
    const result = run(subject({ segment: "B2B" }), action());

    expect(result.verdict).toBe("needs_approval");
    expect(result.gate).toBe("b2b_high_value");
  });

  it("escalates a diagnosis under the confidence floor", () => {
    const result = run(subject({ diagnosisConfidence: 0.42 }), action());

    expect(result.verdict).toBe("needs_approval");
    expect(result.gate).toBe("confidence_below_threshold");
  });

  describe("a routing question is asked once per case, not once per rung", () => {
    it("stops asking whether a B2B account may be worked once a human said yes", () => {
      const cleared = run(
        subject({ segment: "B2B", clearedGates: ["b2b_high_value"] }),
        action(),
      );

      // Re-asking on the next rung is asking the same person the same question
      // four times, and every extra ask is another chance for the case to be
      // closed by a no it had already survived.
      expect(cleared.verdict).toBe("allowed");
      expect(cleared.checks.find((check) => check.name === "Escalation gate")).toMatchObject({
        verdict: "skip",
      });
    });

    it("stops asking about a weak diagnosis once a human has acted on it", () => {
      const cleared = run(
        subject({ diagnosisConfidence: 0.42, clearedGates: ["confidence_below_threshold"] }),
        action(),
      );

      expect(cleared.verdict).toBe("allowed");
    });

    it("still asks about every discount, however many were granted before", () => {
      // A concession is about a specific amount being given away. "Yes to 10%
      // last Tuesday" is not consent to the next one.
      const result = run(
        subject({ clearedGates: ["b2b_high_value", "confidence_below_threshold"] }),
        action({ concessionPaise: 48_000, discountPercent: 10 }),
      );

      expect(result.verdict).toBe("needs_approval");
      expect(result.gate).toBe("discount_requires_approval");
    });

    it("still stands down on hardship, whatever was cleared before", () => {
      const result = run(
        subject({
          hardshipFlaggedAt: new Date("2026-08-20T00:00:00.000Z"),
          clearedGates: ["b2b_high_value", "confidence_below_threshold"],
        }),
        action(),
      );

      expect(result.gate).toBe("hardship_language");
    });

    it("lifts no bound that protects a person", () => {
      // The clearance answers a routing question. It is not a key to the
      // quiet window, the caps, the cool-down or the opt-out.
      const quiet = run(
        subject({ segment: "B2B", clearedGates: ["b2b_high_value"] }),
        action({ at: NIGHT }),
      );
      expect(quiet.outcome).toMatchObject({ kind: "defer" });

      const optedOut = run(
        subject({
          segment: "B2B",
          clearedGates: ["b2b_high_value"],
          optedOutAt: new Date("2026-08-20T00:00:00.000Z"),
        }),
        action(),
      );
      expect(optedOut.outcome).toMatchObject({ kind: "halt" });
    });
  });

  it("escalates hardship language, ahead of any other gate that also fires", () => {
    const result = run(
      subject({ hardshipFlaggedAt: new Date(), diagnosisConfidence: 0.42, segment: "B2B" }),
      action({ concessionPaise: 100 * RUPEE, discountPercent: 2 }),
    );

    expect(result.verdict).toBe("needs_approval");
    expect(result.gate).toBe("hardship_language");
  });

  it("honours the switches — hardship and B2B gates can be turned off", () => {
    const loose = pack((base) => ({
      ...base,
      escalation: { ...base.escalation, hardship: false, b2bAlways: false },
    }));
    const result = run(subject({ hardshipFlaggedAt: new Date(), segment: "B2B" }), action(), loose);

    expect(result.verdict).toBe("allowed");
  });
});

describe("PolicyGate — channel switches and deadlines", () => {
  it("refuses a channel switched off in the pack", () => {
    const off = pack((base) => ({ ...base, channels: { ...base.channels, VOICE: false } }));
    const result = run(subject(), action({ channel: "VOICE" }), off);

    expect(result.verdict).toBe("blocked");
    expect(find(result.checks, "Channel enabled").note).toBe("Voice is switched off in policy v4");
  });

  it("exhausts a case past its deadline rather than chasing stale debt", () => {
    const result = run(
      subject({ deadlineAt: new Date("2026-08-01T00:00:00.000Z") }),
      action(),
    );

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "exhaust" });
    expect(result.terminalStage).toBe("exhausted");
  });

  it("reports the days left while a deadline is still live", () => {
    expect(find(run(subject(), action()).checks, "Deadline").note).toBe("Closes 2026-09-30 · 36d left");
  });

  it("skips the deadline when the stopping rule is off", () => {
    const loose = pack((base) => ({ ...base, rules: { ...base.rules, deadline: false } }));
    const result = run(subject({ deadlineAt: new Date("2026-08-01T00:00:00.000Z") }), action(), loose);

    expect(find(result.checks, "Deadline").verdict).toBe("skip");
    expect(result.verdict).toBe("allowed");
  });
});

describe("PolicyGate — mandate re-presentation (RBI discipline)", () => {
  const mandate = (overrides: Partial<GateSubject> = {}) =>
    subject({ type: "MANDATE_FAILED", ...overrides });

  it("adds the spacing check only for mandate retries", () => {
    expect(
      run(mandate(), action({ channel: "RETRY" })).checks.map((check) => check.name),
    ).toContain("Re-presentation spacing");
    expect(
      run(mandate(), action({ channel: "WHATSAPP" })).checks.map((check) => check.name),
    ).not.toContain("Re-presentation spacing");
    expect(
      run(subject(), action({ channel: "RETRY" })).checks.map((check) => check.name),
    ).not.toContain("Re-presentation spacing");
  });

  it("passes the first presentation of a cycle", () => {
    const result = run(mandate(), action({ channel: "RETRY" }));
    expect(find(result.checks, "Re-presentation spacing").verdict).toBe("pass");
    expect(result.verdict).toBe("allowed");
  });

  it("defers a presentation inside the mandatory spacing", () => {
    const result = run(
      mandate({
        representationsThisCycle: 1,
        lastRepresentationAt: new Date(MIDDAY.getTime() - 1 * DAY),
      }),
      action({ channel: "RETRY" }),
    );

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "defer" });
    expect(find(result.checks, "Re-presentation spacing").note).toContain(
      "1 of 3 clear days since the last presentation",
    );
  });

  it("refuses once the cycle's re-presentations are spent", () => {
    const result = run(
      mandate({ representationsThisCycle: 3, channelUsage: { WHATSAPP: 0, EMAIL: 0, VOICE: 0, RETRY: 0 } }),
      action({ channel: "RETRY" }),
    );

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "refuse" });
    expect(result.terminalStage).toBeNull();
  });

  it("pushes a deferred presentation onto payday when one is within reach", () => {
    // Spacing lands on 2026-08-30; the 1st is two days later, so waiting wins.
    const result = run(
      mandate({
        representationsThisCycle: 1,
        lastRepresentationAt: new Date("2026-08-27T09:00:00.000Z"),
      }),
      action({ channel: "RETRY", at: new Date("2026-08-28T09:00:00.000Z") }),
    );

    expect(result.rescheduledFor?.toISOString()).toBe("2026-09-01T04:30:00.000Z");
    expect(result.outcome).toMatchObject({ kind: "defer" });
  });

  it("does not wait for a payday that is weeks away", () => {
    const lastRepresentationAt = new Date("2026-08-03T09:00:00.000Z");
    const result = run(
      mandate({ representationsThisCycle: 1, lastRepresentationAt }),
      action({ channel: "RETRY", at: new Date("2026-08-04T09:00:00.000Z") }),
    );

    expect(result.rescheduledFor?.getTime()).toBe(lastRepresentationAt.getTime() + 3 * DAY);
  });
});

describe("PolicyGate — verdict precedence", () => {
  it("asks the human now rather than making them wait for the quiet window", () => {
    const result = run(subject({ segment: "B2B" }), action({ at: NIGHT }));

    expect(result.verdict).toBe("needs_approval");
    expect(find(result.checks, "Quiet hours").verdict).toBe("block");
  });

  it("closes an out-of-time case rather than queueing an approval for it", () => {
    const result = run(
      subject({ segment: "B2B", deadlineAt: new Date("2026-08-01T00:00:00.000Z") }),
      action(),
    );

    expect(result.verdict).toBe("blocked");
    expect(result.terminalStage).toBe("exhausted");
  });

  it("halts rather than exhausts when both apply — opt-out is the stronger fact", () => {
    const result = run(
      subject({ optedOutAt: new Date(), attemptsUsed: 4 }),
      action(),
    );

    expect(result.terminalStage).toBe("halted");
  });
});

/**
 * What an approval does and — more importantly — what it does not.
 *
 * The Stage 6 release path re-runs this function with the approver's name
 * attached. The gates that ask a person a question are answered; the bounds
 * that protect a person are not, because "a human said yes" is not a fact about
 * the customer's consent, their quiet hours, or the number of times they have
 * already been contacted.
 */
describe("PolicyGate — an approved action, checked again", () => {
  const APPROVED = {
    gate: "b2b_high_value" as const,
    by: "Demo Merchant",
    at: new Date("2026-08-24T09:05:00.000Z"),
  };

  it("clears the escalation gate that stopped it", () => {
    const over = subject({ amountPaise: 60_000 * RUPEE });

    expect(run(over, action()).verdict).toBe("needs_approval");
    expect(run(over, action({ approvedBy: APPROVED })).verdict).toBe("allowed");
  });

  it("clears every escalation gate at once, not only the one that was named", () => {
    // Cleared for value, but B2B and a low confidence would each have fired
    // next. Asking the same person the same question twice is not a guardrail.
    const layered = subject({
      amountPaise: 60_000 * RUPEE,
      segment: "B2B",
      diagnosisConfidence: 0.41,
    });

    expect(run(layered, action()).verdict).toBe("needs_approval");
    expect(run(layered, action({ approvedBy: APPROVED })).verdict).toBe("allowed");
  });

  it("names the approver in the check the timeline renders", () => {
    const result = run(subject({ segment: "B2B" }), action({ approvedBy: APPROVED }));
    const check = find(result.checks, "Escalation gate");

    expect(check.verdict).toBe("skip");
    expect(check.note).toContain("Demo Merchant");
    expect(check.note).toContain("b2b_high_value");
  });

  it("still refuses a discount above the cap a human is allowed to grant", () => {
    // Nobody here may approve 40%: queueing it asked for something that cannot
    // be given, and clearing it on approval would grant it anyway.
    const result = run(
      subject(),
      action({ concessionPaise: 1_920 * RUPEE, discountPercent: 40, approvedBy: APPROVED }),
    );

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "refuse" });
  });

  it("does not override an opt-out", () => {
    const result = run(
      subject({ optedOutAt: new Date("2026-08-20T00:00:00.000Z") }),
      action({ approvedBy: APPROVED }),
    );

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "halt" });
    expect(result.terminalStage).toBe("halted");
  });

  it("does not override the attempt cap", () => {
    const result = run(subject({ attemptsUsed: 4 }), action({ approvedBy: APPROVED }));

    expect(result.outcome).toMatchObject({ kind: "exhaust" });
  });

  it("does not override a channel cap", () => {
    const result = run(
      subject({ channelUsage: { WHATSAPP: 2, EMAIL: 0, VOICE: 0, RETRY: 0 } }),
      action({ approvedBy: APPROVED }),
    );

    expect(result.outcome).toMatchObject({ kind: "refuse" });
  });

  it("does not override quiet hours — it defers the approved message instead", () => {
    const result = run(subject(), action({ at: NIGHT, approvedBy: APPROVED }));

    expect(result.outcome).toMatchObject({ kind: "defer" });
    expect(result.rescheduledFor).not.toBeNull();
  });

  it("does not override the sentiment halt", () => {
    const result = run(
      subject({ lastSentiment: "negative", lastSentimentScore: -0.82 }),
      action({ approvedBy: APPROVED }),
    );

    expect(result.outcome).toMatchObject({ kind: "halt" });
  });

  it("does not override the cool-down", () => {
    const result = run(
      subject({ lastContactAt: new Date(MIDDAY.getTime() - 2 * HOUR) }),
      action({ approvedBy: APPROVED }),
    );

    expect(result.outcome).toMatchObject({ kind: "defer" });
  });
});

/**
 * D-160 — a human standing on one case may spend its cool-down, and nothing
 * else.
 *
 * The scope is the point of these tests. "Ask Boa to call now" is a merchant
 * deciding the pacing rule protecting an unattended agent should not hold a
 * call they are choosing to make; it is not a way past quiet hours, the caps,
 * or a customer who said STOP. Each of those has its own test here so the day
 * somebody widens `WAIVABLE_CHECKS` the suite says which line they crossed.
 */
describe("PolicyGate — a human override (D-160)", () => {
  const forced = (at = MIDDAY): GateAction =>
    action({ channel: "VOICE", at, override: { by: "Demo Merchant", at } });

  const inCoolDown = () => subject({ lastContactAt: new Date(MIDDAY.getTime() - 5 * HOUR) });

  it("waives a cool-down that would otherwise defer the call", () => {
    const blocked = run(inCoolDown(), action({ channel: "VOICE" }));
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.outcome).toMatchObject({ kind: "defer" });

    const result = run(inCoolDown(), forced());
    expect(result.verdict).toBe("allowed");
    expect(result.outcome).toEqual({ kind: "allow" });
  });

  it("records the waived cool-down as a skip naming who waived it", () => {
    const check = find(run(inCoolDown(), forced()).checks, "Cool-down");

    expect(check.verdict).toBe("skip");
    expect(check.note).toBe(
      "5h since the last contact · minimum 20h — waived by Demo Merchant",
    );
  });

  it("does not waive quiet hours", () => {
    const result = run(subject(), forced(NIGHT));

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "defer" });
    expect(find(result.checks, "Quiet hours").verdict).toBe("block");
  });

  it("does not waive an opt-out", () => {
    const result = run(subject({ optedOutAt: new Date("2026-08-01T00:00:00.000Z") }), forced());

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "halt" });
    expect(find(result.checks, "Opt-out").verdict).toBe("block");
  });

  it("does not waive the attempt cap", () => {
    const result = run(subject({ attemptsUsed: 4 }), forced());

    expect(result.verdict).toBe("blocked");
    expect(result.outcome).toMatchObject({ kind: "exhaust" });
    expect(find(result.checks, "Attempt cap").verdict).toBe("block");
  });

  it("does not waive a channel cap", () => {
    const result = run(
      subject({ channelUsage: { WHATSAPP: 0, EMAIL: 0, VOICE: 1, RETRY: 0 } }),
      forced(),
    );

    expect(result.verdict).toBe("blocked");
    expect(find(result.checks, "Channel cap").verdict).toBe("block");
  });

  it("leaves an unforced call exactly as it was", () => {
    const withOverride = run(inCoolDown(), action({ channel: "VOICE" }));
    expect(withOverride.verdict).toBe("blocked");
    expect(find(withOverride.checks, "Cool-down").note).toBe(
      "5h since the last contact · minimum 20h",
    );
  });
});
