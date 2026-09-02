import { ladderFor, nextWrittenRung } from "./playbooks";

/**
 * The rung a handover card offers (D-151).
 *
 * The walk itself is the planner's, and it is tested through the planner. What
 * is tested here is the narrowing: only channels a person can read before they
 * are sent, only channels this customer can actually receive, and never the one
 * that just failed.
 */
describe("The next written rung", () => {
  it("offers only a channel that has a body to read", () => {
    // This ladder opens on two silent retries.
    expect(ladderFor("PAYMENT_FAILED", "BANK_GATEWAY_DEGRADED")[0]).toBe("RETRY");

    const rung = nextWrittenRung("PAYMENT_FAILED", "BANK_GATEWAY_DEGRADED", 0, {
      phone: true,
      email: true,
    });

    expect(["WHATSAPP", "EMAIL"]).toContain(rung);
  });

  it("skips the channel that just failed", () => {
    const rung = nextWrittenRung("INVOICE_OVERDUE", "CUSTOMER_DISTRACTED", 0, {
      phone: true,
      email: true,
      avoid: "EMAIL",
    });

    expect(rung).toBe("WHATSAPP");
  });

  it("does not offer a channel this customer cannot receive", () => {
    const rung = nextWrittenRung("PAYMENT_FAILED", "INSUFFICIENT_FUNDS", 0, {
      phone: false,
      email: true,
    });

    expect(rung).toBe("EMAIL");
  });

  it("keeps the failed channel rather than inventing an unreachable one", () => {
    // Nothing else is reachable, so the honest answer is the one that failed —
    // the card then says so, instead of naming a channel with no address.
    const rung = nextWrittenRung("INVOICE_OVERDUE", "CUSTOMER_DISTRACTED", 1, {
      phone: false,
      email: true,
      avoid: "EMAIL",
    });

    expect(rung).toBe("EMAIL");
  });

  it("walks past the end of the ladder rather than running out", () => {
    const rung = nextWrittenRung("MANDATE_FAILED", "MANDATE_REVOKED", 9, {
      phone: true,
      email: true,
    });

    expect(["WHATSAPP", "EMAIL"]).toContain(rung);
  });
});
