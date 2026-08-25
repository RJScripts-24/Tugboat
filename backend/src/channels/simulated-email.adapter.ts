import { Injectable } from "@nestjs/common";

import type { GatePass } from "../policy/gate-pass";
import type { ChannelAdapter, ChannelSendResult, SendRequest } from "./channel-adapter.interface";
import { emailMessageId, payLink, seededUnit } from "./channel-refs";
import { emailCopy } from "./message-copy";

/** Resend's free tier costs nothing; this is what the same volume would cost paid. */
const EMAIL_COST_PAISE = 8;

@Injectable()
export class SimulatedEmailAdapter implements ChannelAdapter {
  readonly channel = "EMAIL" as const;
  readonly mode = "simulated" as const;

  async send(pass: GatePass, request: SendRequest): Promise<ChannelSendResult> {
    // An approved draft is sent as the approver left it; only an unattended
    // send derives its own copy.
    const derived = emailCopy(request.copy);
    const mail = request.approved
      ? { subject: request.approved.subject ?? derived.subject, lines: request.approved.lines }
      : derived;
    const opened = seededUnit(`${pass.caseId}/em/${request.attempt}/open`) < 0.62;

    return {
      channelRef: emailMessageId(pass.caseId, request.attempt),
      mode: this.mode,
      costPaise: EMAIL_COST_PAISE,
      detail: {
        kind: "message",
        channel: "EMAIL",
        subject: mail.subject,
        lines: mail.lines,
        link: payLink(pass.caseId),
        status: opened ? "delivered · opened" : "delivered",
      },
    };
  }
}
