import { Inject, Injectable } from "@nestjs/common";

import { maskPhone } from "../common/mask";
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
import { whatsappCopy, whatsappTemplate, withLink } from "./message-copy";
import { PaymentLinkService } from "./payment-links.service";

/**
 * WhatsApp through the Twilio sandbox — a real message leaves the building.
 *
 * The sandbox only delivers to numbers that have joined it, which is the
 * right constraint for a build with no production merchants: nobody who has
 * not typed "join <word>" can be reached. The message body is the same copy
 * the simulated adapter produces, with the case's real payment link in it.
 */
export function twilioMessagesUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
}

/** Indian numbers arrive with or without a country code; Twilio wants E.164. */
export function toE164(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (/^\d{10}$/.test(digits)) return `+91${digits}`;
  if (/^91\d{10}$/.test(digits)) return `+${digits}`;
  throw new Error("Phone number is not in a form Twilio accepts (expected E.164 or a 10-digit Indian number).");
}

@Injectable()
export class TwilioWhatsappAdapter implements ChannelAdapter {
  readonly channel = "WHATSAPP" as const;
  readonly mode = "real" as const;

  constructor(
    private readonly config: AppConfigService,
    private readonly links: PaymentLinkService,
    @Inject(FETCH) private readonly fetchImpl: Fetch,
  ) {}

  async send(pass: GatePass, request: SendRequest): Promise<ChannelSendResult> {
    const twilio = this.config.twilio;
    if (!twilio) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set; the WhatsApp lane cannot be real.");

    const to = toE164(request.to);
    const link = await this.links.linkFor({
      caseId: pass.caseId,
      amountPaise: request.copy.amountPaise,
      customerName: request.copy.customerName,
      phone: to,
      description: `${request.copy.merchantName} · ${request.copy.type.toLowerCase().replace("_", " ")}`,
    });

    const lines = request.approved
      ? withLink(request.approved.lines, link.url)
      : whatsappCopy({ ...request.copy, link: link.url });

    const form = new URLSearchParams({
      From: twilio.whatsappFrom,
      To: `whatsapp:${to}`,
      Body: lines.join("\n"),
      // Twilio answers "queued" synchronously and decides later. Without this
      // callback the case keeps the optimistic answer for ever and shows a
      // delivered message that never arrived (B-76).
      StatusCallback: `${this.config.publicApiUrl}/webhooks/twilio/message-status`,
    });

    const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
    const response = await this.fetchImpl(twilioMessagesUrl(twilio.accountSid), {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Twilio ${response.status} sending to ${maskPhone(to)}: ${describe(text)}`);
    }

    const { sid, status } = JSON.parse(text) as { sid?: string; status?: string };
    if (!sid) throw new Error("Twilio accepted the message but returned no SID.");

    return {
      channelRef: sid,
      mode: this.mode,
      costPaise: CHANNEL_COST_PAISE.WHATSAPP,
      detail: {
        kind: "message",
        channel: "WHATSAPP",
        lines,
        link: link.url,
        template: whatsappTemplate(request.copy.rootCause),
        status: status ? `${status} · Twilio sandbox` : "queued · Twilio sandbox",
      },
    };
  }
}

function describe(text: string): string {
  try {
    const parsed = JSON.parse(text) as { code?: number; message?: string };
    if (parsed.message) return `${parsed.code ?? "error"} — ${parsed.message}`;
  } catch {
    // Not JSON.
  }
  return text.slice(0, 200);
}
