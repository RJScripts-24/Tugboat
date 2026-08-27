import { Injectable } from "@nestjs/common";

import type { GatePass } from "../policy/gate-pass";
import type { ChannelAdapter, ChannelSendResult, SendRequest } from "./channel-adapter.interface";
import { CHANNEL_COST_PAISE } from "./channel-costs";
import { payLink, seededUnit, whatsappMessageId } from "./channel-refs";
import { whatsappCopy, whatsappTemplate } from "./message-copy";

@Injectable()
export class SimulatedWhatsappAdapter implements ChannelAdapter {
  readonly channel = "WHATSAPP" as const;
  readonly mode = "simulated" as const;

  async send(pass: GatePass, request: SendRequest): Promise<ChannelSendResult> {
    // An approved draft is sent as the approver left it; only an unattended
    // send derives its own copy.
    const lines = request.approved?.lines ?? whatsappCopy(request.copy);
    const read = seededUnit(`${pass.caseId}/wa/${request.attempt}/read`) < 0.71;

    return {
      channelRef: whatsappMessageId(pass.caseId, request.attempt),
      mode: this.mode,
      costPaise: CHANNEL_COST_PAISE.WHATSAPP,
      detail: {
        kind: "message",
        channel: "WHATSAPP",
        lines,
        link: payLink(pass.caseId),
        template: whatsappTemplate(request.copy.rootCause),
        status: read ? "delivered · read" : "delivered",
      },
    };
  }
}
