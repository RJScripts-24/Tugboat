import {
  caseTypeForEvent,
  isSuccessEvent,
  normalizeRazorpayWebhook,
  paymentArrivalOf,
  razorpayEventId,
} from "./razorpay.mapper";

const PAYMENT_FAILED = {
  event: "payment.failed",
  created_at: 1_756_000_000,
  payload: {
    payment: {
      entity: {
        id: "pay_S9kQ2fLmX1a2b3",
        amount: 234_000,
        currency: "INR",
        status: "failed",
        method: "upi",
        email: "orders@novafoods.in",
        contact: "9711204431",
        error_code: "BAD_REQUEST_ERROR",
        error_reason: "payment_failed_insufficient_funds",
        error_source: "bank",
        error_description: "Your account does not have enough balance",
        notes: { name: "Nova Foods", language: "hi-IN" },
      },
    },
  },
};

describe("razorpay mapper", () => {
  describe("event routing", () => {
    it("routes the events each playbook opens from", () => {
      expect(caseTypeForEvent("payment.failed")).toBe("PAYMENT_FAILED");
      expect(caseTypeForEvent("subscription.halted")).toBe("MANDATE_FAILED");
      expect(caseTypeForEvent("invoice.expired")).toBe("INVOICE_OVERDUE");
      expect(caseTypeForEvent("payment_link.expired")).toBe("CHECKOUT_ABANDONED");
    });

    it("returns null for events this product does not act on", () => {
      expect(caseTypeForEvent("payment.captured")).toBeNull();
      expect(caseTypeForEvent("refund.created")).toBeNull();
    });
  });

  describe("event id", () => {
    it("prefers the header Razorpay sends", () => {
      expect(razorpayEventId("evt_abc123", "{}")).toBe("evt_abc123");
    });

    it("falls back to a body digest, stable for identical bodies", () => {
      const a = razorpayEventId(undefined, '{"event":"payment.failed"}');
      const b = razorpayEventId(undefined, '{"event":"payment.failed"}');
      const c = razorpayEventId(undefined, '{"event":"payment.captured"}');

      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a.startsWith("sha256:")).toBe(true);
    });

    it("ignores a blank header rather than using it as a key", () => {
      expect(razorpayEventId("   ", "{}").startsWith("sha256:")).toBe(true);
    });
  });

  describe("normalization", () => {
    it("maps a failed UPI payment into the internal shape", () => {
      const event = normalizeRazorpayWebhook(PAYMENT_FAILED, "evt_1");

      expect(event).not.toBeNull();
      expect(event).toMatchObject({
        eventId: "evt_1",
        source: "razorpay",
        eventType: "payment.failed",
        caseType: "PAYMENT_FAILED",
        amountPaise: 234_000,
        currency: "INR",
        origin: { kind: "Razorpay payment", id: "pay_S9kQ2fLmX1a2b3" },
        instrument: "upi",
      });
    });

    it("keeps the amount in paise exactly as Razorpay sends it", () => {
      // Razorpay's API is paise-native, so there is no conversion to get wrong.
      expect(normalizeRazorpayWebhook(PAYMENT_FAILED, "e")?.amountPaise).toBe(234_000);
    });

    it("carries the gateway error through for the diagnoser", () => {
      expect(normalizeRazorpayWebhook(PAYMENT_FAILED, "e")?.failure).toMatchObject({
        code: "BAD_REQUEST_ERROR",
        reason: "payment_failed_insufficient_funds",
        source: "bank",
      });
    });

    it("reads the customer from notes, falling back to contact fields", () => {
      const event = normalizeRazorpayWebhook(PAYMENT_FAILED, "e");

      expect(event?.customer).toMatchObject({
        name: "Nova Foods",
        email: "orders@novafoods.in",
        phone: "9711204431",
        languagePref: "hi-IN",
      });
    });

    it("names the customer from a contact when notes carry no name", () => {
      const body = structuredClone(PAYMENT_FAILED);
      body.payload.payment.entity.notes = {} as never;

      expect(normalizeRazorpayWebhook(body, "e")?.customer.name).toBe("orders@novafoods.in");
    });

    it("returns null for an event with no playbook", () => {
      expect(normalizeRazorpayWebhook({ event: "payment.captured", payload: {} }, "e")).toBeNull();
    });

    it("returns null rather than throwing on a malformed payload", () => {
      expect(normalizeRazorpayWebhook({}, "e")).toBeNull();
      expect(normalizeRazorpayWebhook({ event: "payment.failed" }, "e")).toBeNull();
      expect(
        normalizeRazorpayWebhook({ event: "payment.failed", payload: { payment: {} } }, "e"),
      ).toBeNull();
    });

    it("finds the entity whichever key it arrives under", () => {
      const invoice = {
        event: "invoice.expired",
        payload: { invoice: { entity: { id: "inv_1", amount_due: 5000, invoice_number: "INV-7" } } },
      };

      expect(normalizeRazorpayWebhook(invoice, "e")).toMatchObject({
        caseType: "INVOICE_OVERDUE",
        amountPaise: 5000,
        origin: { id: "inv_1", reference: "INV-7", kind: "Razorpay invoice" },
      });
    });
  });
});

describe("a paid link is a recovery (Stage 10)", () => {
  const PAID_LINK = {
    event: "payment_link.paid",
    created_at: 1_756_000_500,
    payload: {
      payment_link: {
        entity: { id: "plink_1", reference_id: "C-1042", amount: 480_000, amount_paid: 480_000, notes: { tugboat_case: "C-1042" } },
      },
      payment: { entity: { id: "pay_realabc", amount: 480_000, notes: { tugboat_case: "C-1042" } } },
    },
  };

  it("treats payment_link.paid as a success event", () => {
    expect(isSuccessEvent("payment_link.paid")).toBe(true);
    expect(isSuccessEvent("payment.captured")).toBe(true);
  });

  it("maps a paid link to the case its notes name, with the payment id as the reference", () => {
    expect(paymentArrivalOf(PAID_LINK, "evt_1")).toMatchObject({
      eventId: "evt_1",
      caseId: 1042,
      amountPaise: 480_000,
      reference: "pay_realabc",
      via: "Paid from the payment link · Razorpay",
    });
  });

  it("maps a bare payment.captured whose notes name a case", () => {
    const captured = {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_x", amount: 100, notes: { tugboat_case: "C-7" } } } },
    };
    expect(paymentArrivalOf(captured, "evt_2")).toMatchObject({ caseId: 7, reference: "pay_x", amountPaise: 100 });
  });

  it("records an unrelated success as a sample only — no case, no recovery", () => {
    const unrelated = {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_y", amount: 100, notes: {} } } },
    };
    expect(paymentArrivalOf(unrelated, "evt_3")).toBeNull();
  });

  it("does not trust a note that merely looks like a reference", () => {
    const forged = {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_z", amount: 100, notes: { tugboat_case: "C-1 OR 1=1" } } } },
    };
    expect(paymentArrivalOf(forged, "evt_4")).toBeNull();
  });
});

describe("a signed event with no readable amount (Stage 11, B-56)", () => {
  const event = (entity: Record<string, unknown>) => ({
    event: "payment.failed",
    created_at: 1_700_000_000,
    payload: { payment: { entity: { id: "pay_noamount", ...entity } } },
  });

  it("opens no case when the amount is not a number", () => {
    expect(normalizeRazorpayWebhook(event({ amount: "lots" }), "evt_1")).toBeNull();
  });

  it("opens no case at zero", () => {
    expect(normalizeRazorpayWebhook(event({ amount: 0 }), "evt_2")).toBeNull();
  });

  it("still opens a case for a positive amount with garbage beside it", () => {
    const normalized = normalizeRazorpayWebhook(
      event({ amount: 129900, currency: 7, notes: "nope", email: "probe@example.invalid" }),
      "evt_3",
    );

    expect(normalized?.amountPaise).toBe(129900);
    expect(normalized?.currency).toBe("INR");
    expect(normalized?.customer.email).toBe("probe@example.invalid");
  });
});
