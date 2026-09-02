import { Body, Controller, ForbiddenException, Header, HttpCode, Logger, Post, Req } from "@nestjs/common";
import type { Request } from "express";

import { Public } from "../auth/public.decorator";
import { toCaseRef } from "../common/case-ref";
import { AppConfigService } from "../config/app-config.service";
import { ExecutorService } from "../agent-core/executor.service";
import { InboundService } from "../conversation/inbound.service";
import { PrismaService } from "../prisma/prisma.service";
import { twilioSignatureValid } from "../voice/twilio-signature";

/** Stages on which a customer's words still change something. */
const OPEN_STAGES = ["detected", "diagnosed", "intervening", "waiting", "promised", "escalated"] as const;

type TwilioForm = Record<string, string | undefined>;

/**
 * A WhatsApp reply from a real phone (D-146).
 *
 * Twilio posts each inbound sandbox message here. The sender's number names
 * the customer; their most recently touched open live case is the one the
 * reply belongs to; the text then goes through the same `InboundService` the
 * simulator's replies use — so STOP halts, anger escalates and a promise is
 * recorded by exactly the code the batch was graded on. Verified against the
 * account's auth token before anything is read.
 */
@Controller("webhooks/twilio")
export class TwilioInboundController {
  private readonly logger = new Logger(TwilioInboundController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly inbound: InboundService,
    private readonly executor: ExecutorService,
  ) {}

  @Public()
  @Post("whatsapp")
  @HttpCode(200)
  @Header("Content-Type", "text/xml")
  async whatsapp(@Body() body: TwilioForm, @Req() request: Request): Promise<string> {
    const twilio = this.config.twilio;
    if (!twilio) throw new ForbiddenException({ error: "Twilio is not configured." });

    const url = `${this.config.publicApiUrl}${request.originalUrl}`;
    if (!twilioSignatureValid(twilio.authToken, url, body ?? {}, request.header("x-twilio-signature"))) {
      this.logger.warn("Rejected an unsigned inbound WhatsApp webhook");
      throw new ForbiddenException({ error: "Signature did not verify." });
    }

    const phone = (body.From ?? "").replace(/^whatsapp:/, "").trim();
    const text = (body.Body ?? "").trim();
    if (!phone || !text) return EMPTY;

    const record = await this.prisma.case.findFirst({
      where: {
        simRunId: null,
        stage: { in: [...OPEN_STAGES] },
        customer: { phone },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });

    if (!record) {
      this.logger.log(`Inbound WhatsApp from ${mask(phone)} matched no open case; ignored`);
      return EMPTY;
    }

    const outcome = await this.inbound.handle({ caseId: record.id, channel: "WHATSAPP", text });
    this.logger.log(`Inbound WhatsApp from ${mask(phone)} → ${toCaseRef(record.id)} · ${outcome.sentiment} · ${outcome.consequence}`);
    return EMPTY;
  }

  /**
   * Twilio's verdict on a message it accepted earlier (D-154).
   *
   * Registered by the WhatsApp adapter as `StatusCallback`. Twilio posts every
   * transition; only the terminal failures change anything, and the executor
   * decides what. Signature-verified first, exactly like the inbound route
   * above — this endpoint can hand an attempt back to a case, so an unsigned
   * caller must not reach it.
   */
  @Public()
  @Post("message-status")
  @HttpCode(200)
  @Header("Content-Type", "text/xml")
  async messageStatus(@Body() body: TwilioForm, @Req() request: Request): Promise<string> {
    const twilio = this.config.twilio;
    if (!twilio) throw new ForbiddenException({ error: "Twilio is not configured." });

    const url = `${this.config.publicApiUrl}${request.originalUrl}`;
    if (!twilioSignatureValid(twilio.authToken, url, body ?? {}, request.header("x-twilio-signature"))) {
      this.logger.warn("Rejected an unsigned message-status webhook");
      throw new ForbiddenException({ error: "Signature did not verify." });
    }

    const sid = (body.MessageSid ?? body.SmsSid ?? "").trim();
    const status = (body.MessageStatus ?? body.SmsStatus ?? "").trim();
    if (!sid || !status) return EMPTY;

    await this.executor.reconcileDelivery(sid, status, body.ErrorCode ?? null);
    return EMPTY;
  }
}

/** Twilio expects TwiML back; an empty response sends nothing to the customer. */
const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function mask(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 3)}•••${phone.slice(-3)}` : "•••";
}
