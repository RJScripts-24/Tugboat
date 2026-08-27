import { Injectable, Logger, Optional } from "@nestjs/common";

import { toCaseRef } from "../common/case-ref";
import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { payLink } from "./channel-refs";
import { RazorpayClient } from "./razorpay.client";

/**
 * One payment link per case, whichever channel carries it.
 *
 * The link is the recovery: every message the agent sends ends in it, and a
 * silent "retry" in test mode *is* one. Issuing a fresh link per message would
 * hand a customer three URLs for one debt and make "which link did they pay"
 * a question; so the first channel to need it creates it, the row remembers
 * it, and every later contact on the case carries the same one (D-123).
 *
 * In simulated mode nothing is created: the link is the deterministic
 * `rzp.io/l/tug-…` the mock layer has printed since the frontend was built,
 * so a batch's evidence is byte-identical with the service present or not.
 */

export type IssuedLink = {
  url: string;
  providerId: string;
  mode: "simulated" | "real";
  /** True when this call created the link rather than reading it back. */
  created: boolean;
};

export type LinkRequest = {
  caseId: number;
  amountPaise: number;
  currency?: string;
  customerName: string;
  email?: string | null;
  phone?: string | null;
  description: string;
};

/** Links outlive the ladder by a margin: a customer paying on day nine must still find a live page. */
const LINK_TTL_SECONDS = 14 * 24 * 60 * 60;

@Injectable()
export class PaymentLinkService {
  private readonly logger = new Logger(PaymentLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Optional() private readonly client: RazorpayClient | null = null,
  ) {}

  get mode(): "simulated" | "real" {
    return this.config.channelModes.razorpay === "real" && this.client ? "real" : "simulated";
  }

  async linkFor(input: LinkRequest): Promise<IssuedLink> {
    if (this.mode === "simulated") {
      return {
        url: payLink(input.caseId),
        providerId: `plink_sim_${input.caseId}`,
        mode: "simulated",
        created: false,
      };
    }

    const existing = await this.prisma.paymentLink.findUnique({ where: { caseId: input.caseId } });
    if (existing) {
      return { url: existing.shortUrl, providerId: existing.providerId, mode: "real", created: false };
    }

    const ref = toCaseRef(input.caseId);
    const link = await this.client!.createPaymentLink({
      amountPaise: input.amountPaise,
      currency: input.currency ?? "INR",
      referenceId: ref,
      description: input.description,
      customer: {
        name: input.customerName,
        email: input.email ?? undefined,
        contact: input.phone ?? undefined,
      },
      // The webhook reads this back: a `payment.captured` whose notes name a
      // case is a recovery, not just a success sample (D-124).
      notes: { tugboat_case: ref },
      expireBy: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
    });

    await this.prisma.paymentLink.create({
      data: {
        caseId: input.caseId,
        provider: "razorpay",
        providerId: link.id,
        shortUrl: link.short_url,
        amountPaise: input.amountPaise,
      },
    });

    this.logger.log(`${ref} payment link ${link.id} issued (Razorpay test mode)`);

    return { url: link.short_url, providerId: link.id, mode: "real", created: true };
  }
}
