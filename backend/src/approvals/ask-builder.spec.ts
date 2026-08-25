import { OPT_OUT_LINE } from "../channels/message-copy";
import { matchOptOut } from "../conversation/opt-out";
import type { PolicyPack } from "../policy/policy-pack";
import { DISCOUNT_PERCENT, buildAsk, type ApprovalGateName, type AskSubject } from "./ask-builder";

const RUPEE = 100;

const V4: PolicyPack = {
  contact: {
    maxAttempts: 4,
    coolDownHours: 20,
    channelCaps: { WHATSAPP: 2, EMAIL: 2, VOICE: 1, RETRY: 2 },
  },
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

const GATES: ApprovalGateName[] = [
  "discount_requires_approval",
  "b2b_high_value",
  "confidence_below_threshold",
  "hardship_language",
];

function subject(overrides: Partial<AskSubject> = {}): AskSubject {
  return {
    caseId: 1188,
    type: "PAYMENT_FAILED",
    rootCause: "INSUFFICIENT_FUNDS",
    amountPaise: 4_800 * RUPEE,
    attemptsUsed: 2,
    attemptCap: 4,
    confidence: 0.91,
    segment: "B2C",
    customerName: "Ananya Sharma",
    merchantName: "Demo Merchant",
    hinglish: false,
    contact: "98•••••210",
    failureCode: "BAD_REQUEST_ERROR",
    originId: "pay_QkT2mB9xLc41Za",
    lastSentimentScore: -0.71,
    channel: "WHATSAPP",
    ...overrides,
  };
}

const CUSTOMER_FACING = ["WHATSAPP", "EMAIL"];

describe("The ask — properties every gate must hold", () => {
  it.each(GATES)("%s produces a headline, a case for it, and a draft", (gate) => {
    const ask = buildAsk(subject(), gate, V4);

    expect(ask.headline.length).toBeGreaterThan(20);
    expect(ask.justification).toHaveLength(2);
    expect(ask.justification.every((line) => line.length > 40)).toBe(true);
    expect(ask.draft.lines.length).toBeGreaterThan(1);
    expect(ask.draft.note.length).toBeGreaterThan(10);
  });

  it.each(GATES)("%s says what a yes and a no each do", (gate) => {
    const ask = buildAsk(subject(), gate, V4);

    // An approver who cannot see the consequence of either answer is being
    // asked to rubber-stamp rather than to decide.
    expect(ask.ifApproved.length).toBeGreaterThan(30);
    expect(ask.ifRejected.length).toBeGreaterThan(30);
    expect(ask.resumeSteps).toHaveLength(3);
  });

  it.each(GATES)("%s shows the attempt budget on a chip", (gate) => {
    const chips = buildAsk(subject(), gate, V4).chips.map((chip) => chip.label);
    expect(chips).toContain("2 of 4 attempts");
  });

  it.each(GATES)("%s addresses the masked contact, never the real one", (gate) => {
    const ask = buildAsk(subject(), gate, V4);
    if (!CUSTOMER_FACING.includes(ask.draft.channel)) return;

    expect(ask.draft.to).toBe("98•••••210");
  });

  it.each(GATES)("%s never threatens", (gate) => {
    const body = buildAsk(subject(), gate, V4).draft.lines.join(" ").toLowerCase();

    for (const word of ["legal", "court", "recovery agent", "penalty", "police", "blacklist"]) {
      expect(body).not.toContain(word);
    }
  });

  it.each(GATES)("%s keeps the opt-out line on any WhatsApp body", (gate) => {
    for (const hinglish of [false, true]) {
      const ask = buildAsk(subject({ hinglish }), gate, V4);
      if (ask.draft.channel !== "WHATSAPP") continue;

      expect(ask.draft.lines.at(-1)).toBe(OPT_OUT_LINE);
      // And the sign-off must not read as the customer opting themselves out.
      expect(matchOptOut(ask.draft.lines.join("\n"))).toBeNull();
    }
  });
});

describe("The discount ask", () => {
  const ask = buildAsk(subject(), "discount_requires_approval", V4);

  it("costs exactly what it says it costs", () => {
    expect(ask.concessionPaise).toBe(Math.round((4_800 * RUPEE * DISCOUNT_PERCENT) / 100));
    expect(ask.headline).toContain("₹576");
    expect(ask.headline).toContain("₹4,800");
  });

  it("stays inside the cap a human may grant", () => {
    expect(DISCOUNT_PERCENT).toBeLessThanOrEqual(V4.escalation.discountCapPercent);
    expect(ask.chips.map((chip) => chip.label)).toContain("12% ≤ 15% cap");
  });

  it("puts the net figure in the message the customer would read", () => {
    expect(ask.draft.lines.join(" ")).toContain("₹4,224");
  });

  it("says the case resumes rather than closes when it is approved", () => {
    expect(ask.ifApproved).toContain("attempt 3 of 4");
  });

  it("switches the offer to Hinglish for a Hindi-preferring customer", () => {
    const hindi = buildAsk(subject({ hinglish: true }), "discount_requires_approval", V4);
    expect(hindi.draft.lines[0]).toContain("Namaste");
  });
});

describe("The hardship ask", () => {
  it("offers a plan on real money and closes quietly on a small basket", () => {
    const large = buildAsk(subject({ amountPaise: 9_000 * RUPEE }), "hardship_language", V4);
    const small = buildAsk(subject({ amountPaise: 400 * RUPEE }), "hardship_language", V4);

    expect(large.headline).toContain("3 × ₹3,000");
    expect(small.headline).toContain("one acknowledgement");
    expect(small.draft.lines.join(" ")).not.toContain("plan");
  });

  it("gives nothing away — a stand-down is not a concession", () => {
    expect(buildAsk(subject(), "hardship_language", V4).concessionPaise).toBe(0);
  });

  it("quotes the classifier score that halted the case", () => {
    const chips = buildAsk(subject(), "hardship_language", V4).chips.map((chip) => chip.label);
    expect(chips).toContain("sentiment -0.71");
  });

  it("omits the score rather than inventing one when hardship came from a call", () => {
    const chips = buildAsk(
      subject({ lastSentimentScore: null }),
      "hardship_language",
      V4,
    ).chips.map((chip) => chip.label);

    expect(chips.some((label) => label.startsWith("sentiment"))).toBe(false);
  });

  it("writes to the accounts inbox when a business is being offered terms", () => {
    const ask = buildAsk(
      subject({ segment: "B2B", amountPaise: 9_000 * RUPEE }),
      "hardship_language",
      V4,
    );

    expect(ask.draft.channel).toBe("EMAIL");
    expect(ask.draft.subject).toBeDefined();
  });

  it("says a rejection changes nothing about the stand-down", () => {
    expect(buildAsk(subject(), "hardship_language", V4).ifRejected).toContain("stays stood down");
  });
});

describe("The confidence ask", () => {
  it("asks for a silent retry when nothing has been sent yet", () => {
    const ask = buildAsk(
      subject({ attemptsUsed: 0, confidence: 0.41, rootCause: null }),
      "confidence_below_threshold",
      V4,
    );

    expect(ask.draft.channel).toBe("RETRY");
    expect(ask.draft.to).toBe("pay_QkT2mB9xLc41Za");
    expect(ask.draft.note).toContain("contacts nobody");
  });

  it("claims no root cause in a message it is not confident about", () => {
    const ask = buildAsk(
      subject({ attemptsUsed: 2, confidence: 0.44, rootCause: null }),
      "confidence_below_threshold",
      V4,
    );

    expect(ask.draft.channel).toBe("WHATSAPP");
    // The INSUFFICIENT_FUNDS copy names the bank's reason; this must not.
    expect(ask.draft.lines.join(" ")).not.toContain("insufficient balance");
    expect(ask.draft.note).toContain("claims no root cause");
  });

  it("shows where the diagnosis got to, adding up to roughly one", () => {
    const ask = buildAsk(
      subject({ confidence: 0.44, rootCause: null }),
      "confidence_below_threshold",
      V4,
    );

    expect(ask.candidates).toHaveLength(3);
    expect(ask.candidates[0].probability).toBeCloseTo(0.44, 2);
    const total = ask.candidates.reduce((sum, row) => sum + row.probability, 0);
    expect(total).toBeGreaterThan(0.9);
    expect(total).toBeLessThanOrEqual(1.05);
  });

  it("quotes the gateway's own reason code rather than inventing one", () => {
    const ask = buildAsk(
      subject({ failureCode: "GATEWAY_ERROR_0x9F" }),
      "confidence_below_threshold",
      V4,
    );

    expect(ask.justification[0]).toContain("GATEWAY_ERROR_0x9F");
    expect(ask.justification[0]).toContain("0.60 floor");
  });

  it("routes to manual review when it is refused", () => {
    expect(buildAsk(subject(), "confidence_below_threshold", V4).ifRejected).toContain(
      "manual review",
    );
  });
});

describe("The B2B / high-value ask", () => {
  it("names the threshold it crossed", () => {
    const ask = buildAsk(
      subject({ type: "INVOICE_OVERDUE", amountPaise: 42_000 * RUPEE, segment: "B2B" }),
      "b2b_high_value",
      V4,
    );

    expect(ask.headline).toContain("₹42,000");
    expect(ask.headline).toContain("₹25,000");
    expect(ask.draft.channel).toBe("EMAIL");
    expect(ask.draft.subject).toBeDefined();
  });

  it("reads as a routing rule, not a value gate, when the value is under it", () => {
    const ask = buildAsk(
      subject({ type: "INVOICE_OVERDUE", amountPaise: 3_000 * RUPEE, segment: "B2B" }),
      "b2b_high_value",
      V4,
    );

    expect(ask.chips.map((chip) => chip.label)).toContain("B2B always → human");
    expect(ask.justification[0]).toContain("business relationship is not a nudge target");
  });

  it("hands the account back on a rejection", () => {
    const ask = buildAsk(subject({ segment: "B2B" }), "b2b_high_value", V4);
    expect(ask.ifRejected).toContain("stays with you");
  });
});

describe("The ask follows the pack, not a constant", () => {
  it("quotes an edited confidence floor", () => {
    const loosened = structuredClone(V4);
    loosened.escalation.confidenceFloor = 0.8;

    const ask = buildAsk(subject({ confidence: 0.72 }), "confidence_below_threshold", loosened);
    expect(ask.justification[0]).toContain("0.80 floor");
  });

  it("quotes an edited discount cap and cool-down", () => {
    const loosened = structuredClone(V4);
    loosened.escalation.discountCapPercent = 25;
    loosened.contact.coolDownHours = 36;

    const ask = buildAsk(subject(), "discount_requires_approval", loosened);
    expect(ask.chips.map((chip) => chip.label)).toContain("12% ≤ 25% cap");
    expect(ask.resumeSteps[2].detail).toContain("36h cool-down");
  });

  it("quotes an edited value threshold", () => {
    const tightened = structuredClone(V4);
    tightened.escalation.valueThresholdPaise = 5_000 * RUPEE;

    const ask = buildAsk(subject({ amountPaise: 9_000 * RUPEE }), "b2b_high_value", tightened);
    expect(ask.headline).toContain("₹5,000");
  });
});
