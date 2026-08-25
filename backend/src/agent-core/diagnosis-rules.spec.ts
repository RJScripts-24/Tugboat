import { DIAGNOSIS_RULES, applyRules, type DiagnosisSignal } from "./diagnosis-rules";

function signal(overrides: Partial<DiagnosisSignal> = {}): DiagnosisSignal {
  return {
    caseType: "PAYMENT_FAILED",
    failureCode: "BAD_REQUEST_ERROR",
    failureReason: null,
    failureSource: "bank",
    instrument: "upi",
    gatewayDegraded: false,
    ...overrides,
  };
}

describe("diagnosis rules", () => {
  it("has unique, stably-numbered rule ids", () => {
    const ids = DIAGNOSIS_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never claims a confidence it could not justify", () => {
    for (const rule of DIAGNOSIS_RULES) {
      expect(rule.confidence).toBeGreaterThan(0.6);
      expect(rule.confidence).toBeLessThanOrEqual(1);
    }
  });

  describe("known gateway codes resolve without a model", () => {
    it("reads an insufficient-funds decline", () => {
      const hit = applyRules(signal({ failureReason: "payment_failed_insufficient_funds" }));
      expect(hit).toMatchObject({ rootCause: "INSUFFICIENT_FUNDS", rule: { id: "R-03" } });
    });

    it("reads an expired card", () => {
      const hit = applyRules(signal({ failureReason: "payment_card_expired" }));
      expect(hit).toMatchObject({ rootCause: "CARD_EXPIRED", rule: { id: "R-02" } });
    });

    it("reads a revoked mandate", () => {
      const hit = applyRules(
        signal({ caseType: "MANDATE_FAILED", failureReason: "mandate_revoked_by_customer" }),
      );
      expect(hit).toMatchObject({ rootCause: "MANDATE_REVOKED", rule: { id: "R-01" } });
    });

    it("reads an explicit gateway timeout even with no degradation detected", () => {
      const hit = applyRules(
        signal({ failureCode: "GATEWAY_ERROR", failureReason: "payment_upi_collect_timeout" }),
      );
      expect(hit).toMatchObject({ rootCause: "BANK_GATEWAY_DEGRADED", rule: { id: "R-05" } });
    });
  });

  describe("context changes the reading", () => {
    it("blames the gateway for a vague timeout when a degradation is in progress", () => {
      const hit = applyRules(
        signal({ failureCode: "SERVER_ERROR", failureReason: "timeout", gatewayDegraded: true }),
      );
      expect(hit).toMatchObject({ rootCause: "BANK_GATEWAY_DEGRADED", rule: { id: "R-04" } });
      expect(hit!.confidence).toBeGreaterThan(0.9);
    });

    it("still blames the customer's mandate over a coincident outage", () => {
      // Ordering matters: no amount of retrying fixes a revoked mandate, so a
      // revocation outranks the gateway rules even during an outage.
      const hit = applyRules(
        signal({
          caseType: "MANDATE_FAILED",
          failureReason: "mandate_revoked_by_customer timeout",
          gatewayDegraded: true,
        }),
      );
      expect(hit!.rootCause).toBe("MANDATE_REVOKED");
    });
  });

  describe("signals with no gateway error", () => {
    it("reads an abandoned cart as distraction", () => {
      const hit = applyRules(
        signal({ caseType: "CHECKOUT_ABANDONED", failureCode: null, failureReason: null }),
      );
      expect(hit).toMatchObject({ rootCause: "CUSTOMER_DISTRACTED", rule: { id: "R-06" } });
    });

    it("reads an overdue invoice as distraction, less confidently", () => {
      const hit = applyRules(
        signal({ caseType: "INVOICE_OVERDUE", failureCode: null, failureReason: null }),
      );
      expect(hit).toMatchObject({ rootCause: "CUSTOMER_DISTRACTED", rule: { id: "R-07" } });
      expect(hit!.confidence).toBeLessThan(0.82);
    });
  });

  describe("falling through to the model", () => {
    it("returns null for an unmapped reason code rather than guessing", () => {
      expect(applyRules(signal({ failureReason: "payment_failed_unknown_reason" }))).toBeNull();
    });

    it("returns null for a failed payment with no error at all", () => {
      expect(applyRules(signal({ failureCode: null, failureReason: null }))).toBeNull();
    });

    it("does not apply the abandonment rule to a payment failure", () => {
      // R-06 is scoped to CHECKOUT_ABANDONED; without that scope a silent
      // payment failure would be mislabelled as distraction.
      expect(
        applyRules(signal({ caseType: "PAYMENT_FAILED", failureCode: null, failureReason: null })),
      ).toBeNull();
    });
  });

  it("is deterministic — the same signal always yields the same rule", () => {
    const input = signal({ failureReason: "payment_failed_insufficient_funds" });
    const first = applyRules(input);
    const second = applyRules(input);

    expect(first!.rule.id).toBe(second!.rule.id);
    expect(first!.confidence).toBe(second!.confidence);
  });
});
