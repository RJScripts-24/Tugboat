import { Injectable } from "@nestjs/common";

import type { GatePass } from "../policy/gate-pass";
import type { ChannelAdapter, ChannelSendResult, SendRequest } from "./channel-adapter.interface";
import { razorpayPaymentId, seededInt, seededUnit } from "./channel-refs";

/**
 * A re-presentation of the payment. Contacts nobody.
 *
 * Whether it captures is decided by a seeded hash of the case and attempt, so a
 * rerun of the same batch produces the same outcome — the evidence report is
 * only reproducible if the individual results are. The odds are deliberately
 * unkind: a retry against the same card and the same balance usually fails
 * again, and later attempts do better only because time has passed.
 */
const CAPTURE_ODDS: Record<string, number> = {
  BANK_GATEWAY_DEGRADED: 0.62,
  INSUFFICIENT_FUNDS: 0.24,
  CARD_EXPIRED: 0.03,
  MANDATE_REVOKED: 0.02,
  CUSTOMER_DISTRACTED: 0.18,
  UNKNOWN: 0.15,
};

const DECLINE_REASON: Record<string, string> = {
  BANK_GATEWAY_DEGRADED: "gateway_timeout — upstream still unstable",
  INSUFFICIENT_FUNDS: "payment_failed_insufficient_funds",
  CARD_EXPIRED: "payment_card_expired",
  MANDATE_REVOKED: "mandate_revoked_by_customer",
  CUSTOMER_DISTRACTED: "payment_not_attempted",
  UNKNOWN: "payment_failed_unknown_reason",
};

@Injectable()
export class SimulatedRetryAdapter implements ChannelAdapter {
  readonly channel = "RETRY" as const;
  readonly mode = "simulated" as const;

  async send(pass: GatePass, request: SendRequest): Promise<ChannelSendResult> {
    const cause = request.copy.rootCause ?? "UNKNOWN";
    const seed = `${pass.caseId}/retry/${request.attempt}`;

    // Each attempt is a little likelier than the last: funds arrive, outages
    // clear. Capped, because a fourth retry is not a coin flip.
    const odds = Math.min(0.75, (CAPTURE_ODDS[cause] ?? 0.15) * (1 + 0.35 * (request.attempt - 1)));
    // The caller's answer wins where there is one: a graded batch decides this
    // from the true cause and the customer's balance, not from the diagnosis
    // the agent happened to reach.
    const captured = request.captured ?? seededUnit(seed) < odds;

    return {
      channelRef: razorpayPaymentId(pass.caseId, request.attempt),
      mode: this.mode,
      // A retry costs the merchant nothing until it captures, and the MDR on a
      // captured payment is not the agent's spend to report.
      costPaise: 0,
      detail: {
        kind: "retry",
        captured,
        gatewayLatencyMs: seededInt(`${seed}/latency`, 310, 2400),
        failureReason: captured ? null : (DECLINE_REASON[cause] ?? DECLINE_REASON.UNKNOWN),
      },
    };
  }
}
