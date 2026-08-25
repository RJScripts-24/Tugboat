import {
  OPT_OUT_LINE,
  discountCopy,
  emailCopy,
  ensureOptOut,
  hardshipCopy,
  whatsappCopy,
  type CopyContext,
} from "./message-copy";
import { matchOptOut } from "../conversation/opt-out";

const ROOT_CAUSES = [
  "BANK_GATEWAY_DEGRADED",
  "INSUFFICIENT_FUNDS",
  "CUSTOMER_DISTRACTED",
  "CARD_EXPIRED",
  "MANDATE_REVOKED",
  "UNKNOWN",
] as const;

const CASE_TYPES = [
  "PAYMENT_FAILED",
  "CHECKOUT_ABANDONED",
  "MANDATE_FAILED",
  "INVOICE_OVERDUE",
] as const;

function ctx(overrides: Partial<CopyContext> = {}): CopyContext {
  return {
    caseId: 1001,
    type: "PAYMENT_FAILED",
    rootCause: "INSUFFICIENT_FUNDS",
    amountPaise: 480_000,
    customerName: "Ananya Sharma",
    merchantName: "Demo Merchant",
    hinglish: false,
    attempt: 1,
    ...overrides,
  };
}

/** Every combination the ladder can actually produce. */
const everyVariant = CASE_TYPES.flatMap((type) =>
  ROOT_CAUSES.flatMap((rootCause) =>
    [false, true].flatMap((hinglish) =>
      [1, 2].map((attempt) => ctx({ type, rootCause, hinglish, attempt })),
    ),
  ),
);

describe("WhatsApp copy", () => {
  it.each(everyVariant.map((variant) => [describeVariant(variant), variant]))(
    "%s ends with the opt-out line",
    (_label, variant) => {
      const lines = whatsappCopy(variant);
      // Appended by construction rather than by remembering: a nudge with no way
      // out is the thing the regulator objects to.
      expect(lines.at(-1)).toBe(OPT_OUT_LINE);
    },
  );

  it.each(everyVariant.map((variant) => [describeVariant(variant), variant]))(
    "%s introduces Boa by name on the merchant's behalf",
    (_label, variant) => {
      const first = whatsappCopy(variant)[0];
      expect(first).toContain("Boa");
      expect(first).toContain("Demo Merchant");
    },
  );

  it.each(everyVariant.map((variant) => [describeVariant(variant), variant]))(
    "%s uses the first name only, never the full one",
    (_label, variant) => {
      const body = whatsappCopy(variant).join(" ");
      expect(body).toContain("Ananya");
      expect(body).not.toContain("Ananya Sharma");
    },
  );

  it.each(everyVariant.map((variant) => [describeVariant(variant), variant]))(
    "%s never threatens",
    (_label, variant) => {
      const body = whatsappCopy(variant).join(" ").toLowerCase();
      for (const word of ["legal", "court", "recovery agent", "penalty", "police", "blacklist"]) {
        expect(body).not.toContain(word);
      }
    },
  );

  it("carries the amount and a payment link", () => {
    const lines = whatsappCopy(ctx());
    expect(lines.join(" ")).toContain("4,800");
    expect(lines.join(" ")).toMatch(/rzp\.io\/l\/tug-[0-9a-f]{6}/);
  });

  it("switches to Hinglish for a Hindi-preferring customer", () => {
    expect(whatsappCopy(ctx({ hinglish: true }))[0]).toContain("Namaste");
    expect(whatsappCopy(ctx({ hinglish: false }))[0]).toContain("Hi ");
  });

  it("blames the bank, not the customer, when the bank was at fault", () => {
    const lines = whatsappCopy(ctx({ rootCause: "BANK_GATEWAY_DEGRADED" })).join(" ");
    expect(lines).toContain("not at your end");
  });

  it("does not accidentally opt the customer out with its own sign-off", () => {
    // The message ends with "Reply STOP if...". If a customer quotes it back,
    // the matcher must not read that as an opt-out (D-52).
    expect(matchOptOut(whatsappCopy(ctx()).join("\n"))).toBeNull();
  });
});

describe("email copy", () => {
  it.each(everyVariant.map((variant) => [describeVariant(variant), variant]))(
    "%s has a subject and signs off as Boa",
    (_label, variant) => {
      const mail = emailCopy(variant);
      expect(mail.subject.length).toBeGreaterThan(5);
      expect(mail.lines.at(-1)).toBe("— Boa, on behalf of Demo Merchant");
    },
  );

  it("gets firmer on a second invoice reminder, without threatening", () => {
    const first = emailCopy(ctx({ type: "INVOICE_OVERDUE", attempt: 1 }));
    const second = emailCopy(ctx({ type: "INVOICE_OVERDUE", attempt: 2 }));

    expect(first.subject).toContain("past its due date");
    expect(second.subject).toContain("Second reminder");
    expect(second.lines.join(" ").toLowerCase()).not.toContain("legal");
  });

  it("says the mandate was withdrawn rather than that the customer failed", () => {
    const mail = emailCopy(ctx({ type: "MANDATE_FAILED", rootCause: "MANDATE_REVOKED" }));
    expect(mail.lines.join(" ")).toContain("If that was deliberate, no action is needed");
  });
});

function describeVariant(variant: CopyContext): string {
  return `${variant.type}/${variant.rootCause}/${variant.hinglish ? "hi" : "en"}/attempt ${variant.attempt}`;
}

/**
 * Copy that only a human can release.
 *
 * These two variants are unreachable by the agent alone — the escalation gate
 * stops any action carrying a concession, and a hardship flag halts everything
 * — but they are still customer-facing messages, so they are held to the same
 * rules as the ones Boa sends unattended.
 */
describe("approval-only copy", () => {
  const bodies = [false, true].flatMap((hinglish) => [
    ["discount/" + (hinglish ? "hi" : "en"), discountCopy(ctx({ hinglish }), 12)] as const,
    [
      "hardship-plan/" + (hinglish ? "hi" : "en"),
      hardshipCopy(ctx({ hinglish }), { plan: true, instalmentPaise: 160_000, email: false }).lines,
    ] as const,
    [
      "hardship-close/" + (hinglish ? "hi" : "en"),
      hardshipCopy(ctx({ hinglish }), { plan: false, instalmentPaise: 0, email: false }).lines,
    ] as const,
  ]);

  it.each(bodies)("%s ends with the opt-out line", (_label, lines) => {
    expect(lines.at(-1)).toBe(OPT_OUT_LINE);
  });

  it.each(bodies)("%s never threatens", (_label, lines) => {
    const body = lines.join(" ").toLowerCase();
    for (const word of ["legal", "court", "recovery agent", "penalty", "police", "blacklist"]) {
      expect(body).not.toContain(word);
    }
  });

  it.each(bodies)("%s uses the first name only", (_label, lines) => {
    const body = lines.join(" ");
    expect(body).toContain("Ananya");
    expect(body).not.toContain("Ananya Sharma");
  });

  it.each(bodies)("%s does not read as the customer opting out", (_label, lines) => {
    expect(matchOptOut(lines.join("\n"))).toBeNull();
  });

  it("states both the original and the discounted figure", () => {
    const lines = discountCopy(ctx(), 12).join(" ");
    expect(lines).toContain("₹4,800");
    expect(lines).toContain("₹4,224");
  });

  it("introduces Boa on the merchant's behalf when it is offering money back", () => {
    expect(discountCopy(ctx(), 12)[0]).toContain("Boa");
    expect(discountCopy(ctx(), 12)[0]).toContain("Demo Merchant");
  });

  it("asks a customer in hardship for nothing", () => {
    const lines = hardshipCopy(ctx(), { plan: true, instalmentPaise: 160_000, email: false })
      .lines.join(" ")
      .toLowerCase();

    expect(lines).toContain("paused all reminders");
    expect(lines).not.toContain("pay now");
    expect(lines).not.toContain("complete it");
  });

  it("does not offer a plan in the message when it is closing quietly", () => {
    const lines = hardshipCopy(ctx(), { plan: false, instalmentPaise: 0, email: false }).lines;
    expect(lines.join(" ")).toContain("will not contact you about this again");
  });

  it("carries a subject only when it is going out as email", () => {
    const asEmail = hardshipCopy(ctx(), { plan: true, instalmentPaise: 160_000, email: true });
    const asChat = hardshipCopy(ctx(), { plan: true, instalmentPaise: 160_000, email: false });

    expect(asEmail.subject).toBeDefined();
    expect(asChat.subject).toBeUndefined();
  });
});

describe("ensureOptOut — the line an approver may not delete", () => {
  it("leaves a compliant body untouched", () => {
    const lines = whatsappCopy(ctx());
    const result = ensureOptOut(lines);

    expect(result.restored).toBe(false);
    expect(result.lines).toBe(lines);
  });

  it("puts the line back when an edit dropped it, and says that it did", () => {
    const stripped = whatsappCopy(ctx()).slice(0, -1);
    const result = ensureOptOut(stripped);

    expect(result.restored).toBe(true);
    expect(result.lines.at(-1)).toBe(OPT_OUT_LINE);
    expect(result.lines).toHaveLength(stripped.length + 1);
  });

  it("does not double it up when the approver moved it rather than deleting it", () => {
    const moved = [OPT_OUT_LINE, ...whatsappCopy(ctx()).slice(0, -1)];
    const result = ensureOptOut(moved);

    expect(result.restored).toBe(false);
    expect(result.lines.filter((line) => line === OPT_OUT_LINE)).toHaveLength(1);
  });

  it("tolerates the whitespace a textarea leaves behind", () => {
    const padded = [...whatsappCopy(ctx()).slice(0, -1), `  ${OPT_OUT_LINE}  `];
    expect(ensureOptOut(padded).restored).toBe(false);
  });
});
