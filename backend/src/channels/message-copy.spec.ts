import { OPT_OUT_LINE, emailCopy, whatsappCopy, type CopyContext } from "./message-copy";
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
