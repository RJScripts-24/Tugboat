import { Inject, Injectable } from "@nestjs/common";

import { maskEmail } from "../common/mask";
import { AppConfigService } from "../config/app-config.service";
import type { GatePass } from "../policy/gate-pass";
import {
  FETCH,
  type ChannelAdapter,
  type ChannelSendResult,
  type Fetch,
  type SendRequest,
} from "./channel-adapter.interface";
import { CHANNEL_COST_PAISE } from "./channel-costs";
import { emailCopy, ensureOptOut, withLink, withLinkLine } from "./message-copy";
import { PaymentLinkService } from "./payment-links.service";

/**
 * Email through Resend — a real message leaves the building.
 *
 * Same shape as the simulated adapter on purpose: the gate pass first, the
 * approved draft honoured verbatim, the opt-out line intact. What differs is
 * that the link in the body is the case's real payment link and the id that
 * comes back is Resend's. The address is masked before it reaches a log.
 */
export const RESEND_API = "https://api.resend.com/emails";

@Injectable()
export class ResendEmailAdapter implements ChannelAdapter {
  readonly channel = "EMAIL" as const;
  readonly mode = "real" as const;

  constructor(
    private readonly config: AppConfigService,
    private readonly links: PaymentLinkService,
    @Inject(FETCH) private readonly fetchImpl: Fetch,
  ) {}

  async send(pass: GatePass, request: SendRequest): Promise<ChannelSendResult> {
    const apiKey = this.config.resendApiKey;
    if (!apiKey) throw new Error("RESEND_API_KEY is not set; the email lane cannot be real.");
    if (!request.to.includes("@")) throw new Error("No email address on file for this customer.");

    const link = await this.links.linkFor({
      caseId: pass.caseId,
      amountPaise: request.copy.amountPaise,
      customerName: request.copy.customerName,
      email: request.to,
      description: `${request.copy.merchantName} · ${request.copy.type.toLowerCase().replace("_", " ")}`,
    });

    const derived = emailCopy({ ...request.copy, link: link.url });
    // The email copy keeps its link out of the prose and carries no opt-out
    // line, because the timeline renders both as fields beside the message. A
    // real inbox has no fields: the link goes in above the sign-off and the
    // way out is restored at the end, by the same helper that guards approved
    // drafts (D-68, D-127).
    const body = (lines: string[]) => ensureOptOut(withLinkLine(lines, link.url)).lines;
    const mail = request.approved
      ? {
          subject: request.approved.subject ?? derived.subject,
          lines: body(withLink(request.approved.lines, link.url)),
        }
      : { subject: derived.subject, lines: body(derived.lines) };

    const response = await this.fetchImpl(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        from: this.config.resendFrom,
        to: [request.to],
        subject: mail.subject,
        text: mail.lines.join("\n\n"),
        headers: { "X-Tugboat-Case": String(pass.caseId) },
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Resend ${response.status} sending to ${maskEmail(request.to)}: ${text.slice(0, 200)}`);
    }

    const { id } = JSON.parse(text) as { id?: string };
    if (!id) throw new Error("Resend accepted the email but returned no id.");

    return {
      channelRef: id,
      mode: this.mode,
      costPaise: CHANNEL_COST_PAISE.EMAIL,
      detail: {
        kind: "message",
        channel: "EMAIL",
        subject: mail.subject,
        lines: mail.lines,
        link: link.url,
        status: "accepted by Resend",
      },
    };
  }
}
