import { caseTypeForEvent, normalizeRazorpayWebhook, razorpayEventId } from "./razorpay.mapper";

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
