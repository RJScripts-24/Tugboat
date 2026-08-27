import { Injectable } from "@nestjs/common";

import type { GatePass } from "../policy/gate-pass";
import type { ChannelAdapter, ChannelSendResult, SendRequest } from "./channel-adapter.interface";
import { PaymentLinkService } from "./payment-links.service";

/**
 * The "silent retry", against Razorpay in test mode.
 *
 * Honesty first: there is no API that re-charges a failed one-off card or UPI
 * payment on the merchant's say-so — the customer has to act — and a mandate
 * is re-presented by Razorpay on its own schedule. What a merchant can do
 * server-side is keep a live payment link against the debt, so that when the
 * customer's balance or card is fixed the money has somewhere to land. That is
 * what this adapter does, once per case, and it says so in the timeline.
 *
 * The capture therefore never happens here. It arrives later as a
 * `payment.captured` / `payment_link.paid` webhook whose notes name the case,
 * and the ingestion door records the recovery (D-124). `captured` is false and
 * `awaiting` names what is being waited for, so the executor renders "link
 * live, awaiting capture" rather than "declined".
 */
@Injectable()
export class RazorpayRetryAdapter implements ChannelAdapter {
  readonly channel = "RETRY" as const;
  readonly mode = "real" as const;

  constructor(private readonly links: PaymentLinkService) {}

  async send(pass: GatePass, request: SendRequest): Promise<ChannelSendResult> {
    const startedAt = Date.now();

    const link = await this.links.linkFor({
      caseId: pass.caseId,
      amountPaise: request.copy.amountPaise,
      customerName: request.copy.customerName,
      description: `${request.copy.merchantName} · ${request.copy.type.toLowerCase().replace("_", " ")}`,
    });

    const awaiting =
      request.copy.type === "MANDATE_FAILED"
        ? "Razorpay re-presents the mandate on its own schedule — awaiting subscription.charged"
        : link.created
          ? "Payment link issued — awaiting payment.captured from Razorpay"
          : "Payment link still live — awaiting payment.captured from Razorpay";

    return {
      channelRef: link.providerId,
      mode: this.mode,
      costPaise: 0,
      detail: {
        kind: "retry",
        captured: false,
        gatewayLatencyMs: Date.now() - startedAt,
        failureReason: null,
        awaiting,
        link: link.url,
      },
    };
  }
}
