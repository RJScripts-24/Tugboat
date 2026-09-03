import { Inject, Injectable, Logger } from "@nestjs/common";

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

/**
 * Whether Twilio can call back to this URL at all.
 *
 * Twilio rejects a message whose StatusCallback it cannot possibly reach —
 * loopback hosts and plain HTTP to a private name — with error 21609, before
 * the message is sent (B-91). This is that rule, stated where the URL is chosen.
 */
export function isPubliclyReachable(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return false;
    const host = hostname.toLowerCase();
    return !(
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      /^127./.test(host) ||
      /^10./.test(host) ||
      /^192.168./.test(host) ||
      /^172.(1[6-9]|2d|3[01])./.test(host)
    );
  } catch {
    return false;
  }
}

@Injectable()
export class TwilioWhatsappAdapter implements ChannelAdapter {
  private readonly logger = new Logger(TwilioWhatsappAdapter.name);
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
    });

    // Twilio answers "queued" synchronously and decides later. Without this
    // callback the case keeps the optimistic answer for ever and shows a
    // delivered message that never arrived (B-76). But Twilio validates the
    // URL before it accepts the message, and a loopback address fails that
    // check with error 21609 — so on a laptop with no tunnel the callback did
    // not degrade the status, it killed the message (B-91). Reachable URL: the
    // callback goes on. Loopback: the message goes out and the status stays at
    // Twilio's own "queued", which is the honest reading of what we know.
    if (isPubliclyReachable(this.config.publicApiUrl)) {
      form.set("StatusCallback", `${this.config.publicApiUrl}/webhooks/twilio/message-status`);
    } else {
      this.logger.warn(
        `PUBLIC_API_URL is ${this.config.publicApiUrl}; Twilio cannot reach it, so the WhatsApp to ${maskPhone(to)} goes out without a status callback`,
      );
    }

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
