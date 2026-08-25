import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";

import { Public } from "../auth/public.decorator";
import { AppConfigService } from "../config/app-config.service";
import { InboundService, type InboundOutcome } from "../conversation/inbound.service";
import { SimEventDto } from "./dto/sim-event.dto";
import { SimReplyDto } from "./dto/sim-reply.dto";
import { IngestionService, type IngestOutcome } from "./ingestion.service";
import { isSuccessEvent, normalizeRazorpayWebhook, razorpayEventId } from "./razorpay.mapper";
import { verifyRazorpaySignature } from "./razorpay.signature";

/** Razorpay keys the payload by entity name; which key is present depends on the event. */
function firstEntity(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const payload = body.payload as Record<string, { entity?: Record<string, unknown> }> | undefined;
  if (!payload) return undefined;

  return Object.values(payload).find((wrapper) => wrapper?.entity)?.entity;
}

@Controller()
export class IngestionController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly inbound: InboundService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Public because Razorpay cannot present a JWT. The signature is the
   * authentication: without a valid HMAC over the exact bytes received, nothing
   * past this check runs.
   */
  @Public()
  @Post("webhooks/razorpay")
  @HttpCode(200)
  async razorpay(
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature: string | undefined,
    @Headers("x-razorpay-event-id") eventIdHeader: string | undefined,
  ): Promise<IngestOutcome> {
    const secret = this.config.razorpayWebhookSecret;

    // Fail closed. An unconfigured secret means signatures cannot be checked,
    // and an unauthenticated case-creation endpoint is worse than a dead one.
    if (!secret) {
      throw new ServiceUnavailableException({
        error: "Webhook secret is not configured; refusing to accept unverified deliveries.",
      });
    }

    const rawBody = request.rawBody;
    if (!rawBody || !verifyRazorpaySignature(rawBody, signature, secret)) {
      throw new UnauthorizedException({ error: "Invalid webhook signature." });
    }

    const body = request.body as Record<string, unknown>;
    const eventId = razorpayEventId(eventIdHeader, rawBody);
    const eventType = String(body.event ?? "unknown");

    // A successful payment opens no case, but the detector counts it: without
    // successes there is no denominator, and a failure rate cannot be computed.
    if (isSuccessEvent(eventType)) {
      const entity = firstEntity(body);
      return this.ingestion.recordSuccess({
        eventId,
        eventType,
        at: typeof body.created_at === "number" ? new Date(body.created_at * 1000) : undefined,
        method: typeof entity?.method === "string" ? entity.method : null,
        bank: typeof entity?.bank === "string" ? entity.bank : null,
        raw: body,
      });
    }

    const event = normalizeRazorpayWebhook(body, eventId);

    if (!event) {
      return this.ingestion.acknowledgeUnhandled(
        eventId,
        "razorpay",
        String(body.event ?? "unknown"),
        body,
      );
    }

    return this.ingestion.ingest(event);
  }

  /**
   * The simulator's door. Guarded by the ordinary session guard rather than a
   * second auth scheme: it is a merchant-triggered tool, and in Stage 8 the
   * batch runner calls IngestionService directly in-process rather than over
   * HTTP, so no machine credential is needed.
   */
  @Post("sim/events")
  @HttpCode(202)
  simulate(@Body() dto: SimEventDto): Promise<IngestOutcome> {
    return this.ingestion.ingest(this.ingestion.normalizeSimEvent(dto));
  }

  /**
   * An inbound reply. The same door the real provider webhooks will use in
   * Stage 10, so opt-out and sentiment are measured on the production path.
   */
  @Post("sim/replies")
  @HttpCode(202)
  reply(@Body() dto: SimReplyDto): Promise<InboundOutcome> {
    return this.inbound.handle({
      caseId: dto.caseId,
      channel: dto.channel,
      text: dto.text,
      at: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
    });
  }
}
