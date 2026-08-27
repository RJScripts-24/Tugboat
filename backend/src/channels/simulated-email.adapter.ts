import { Injectable } from "@nestjs/common";

import type { GatePass } from "../policy/gate-pass";
import type { ChannelAdapter, ChannelSendResult, SendRequest } from "./channel-adapter.interface";
import { CHANNEL_COST_PAISE } from "./channel-costs";
import { emailMessageId, payLink, seededUnit } from "./channel-refs";
import { emailCopy } from "./message-copy";

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
      costPaise: CHANNEL_COST_PAISE.EMAIL,
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
