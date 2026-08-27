import { randomUUID } from "node:crypto";

import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { DetectorService } from "../agent-core/detector.service";
import { DiagnoserService } from "../agent-core/diagnoser.service";
import { ExecutorService } from "../agent-core/executor.service";
import { isUniqueViolation } from "../cases/case-events.service";
import { CasesService } from "../cases/cases.service";
import { toCaseRef } from "../common/case-ref";
import { ClockService } from "../common/clock.service";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE, type ActionQueue } from "../queue/action-queue.interface";
import { cancelCaseWork } from "../queue/cancel-case-work";
import type { SimEventDto } from "./dto/sim-event.dto";
import type { NormalizedEvent } from "./normalized-event";

/**
 * How long a claim is assumed to be alive. Longer than any realistic
 * detect-and-diagnose pass, short enough that a crashed attempt is retried
 * within one webhook redelivery cycle.
 */
const STALE_CLAIM_MS = 5 * 60_000;

export type DiagnosisSummary = {
  rootCause: string;
  confidence: number;
  method: string;
  escalated: boolean;
};

export type IngestOutcome =
  | { status: "accepted"; caseId: number; caseRef: string; diagnosis?: DiagnosisSummary }
  | { status: "duplicate"; caseRef: string | null }
  | { status: "ignored"; reason: string }
  | { status: "recorded"; outcome: "success" }
  | { status: "recovered"; caseId: number; caseRef: string; amountPaise: number };

/** A payment landing against a case that is already open. */
export type PaymentArrival = {
  eventId: string;
  /** The Razorpay object the case was opened from. Either this or caseId. */
  originId?: string;
  caseId?: number;
  amountPaise: number;
  at?: Date;
  /** The provider-side payment id, printed on the timeline. */
  reference: string;
  /** How the money arrived, for the timeline row. */
  via?: string;
  raw?: unknown;
  /** Who delivered it: the simulator in a batch, Razorpay through the webhook (Stage 10). */
  source?: "simulator" | "razorpay";
};

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cases: CasesService,
    private readonly detector: DetectorService,
    private readonly diagnoser: DiagnoserService,
    private readonly executor: ExecutorService,
    private readonly clock: ClockService,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
  ) {}

  /**
   * Records the event, then opens a case for it.
   *
   * The de-duplication row is written *before* any work happens, so a second
   * delivery of the same event loses the insert race and does nothing. The
   * unique constraint on eventId is the entire mechanism — no read-then-write
   * check, which two concurrent deliveries could both pass.
   */
  async ingest(event: NormalizedEvent): Promise<IngestOutcome> {
    const claimed = await this.claim(event);

    if (!claimed.proceed) {
      this.logger.log(`Duplicate delivery of ${event.eventId}; nothing to do`);
      return {
        status: "duplicate",
        caseRef: claimed.caseId ? toCaseRef(claimed.caseId) : null,
      };
    }

    const merchantId = await this.resolveMerchantId();

    // DETECT: the failure is a data point about gateway health before it is a
    // case, and the detector needs it recorded before diagnosis asks whether a
    // degradation was in progress.
    await this.detector.recordOutcome({
      merchantId,
      success: false,
      at: event.occurredAt,
      method: event.instrument,
      bank: event.failure?.source,
    });

    const record = await this.cases.openFromEvent(merchantId, event);

    await this.prisma.webhookEvent.update({
      where: { eventId: event.eventId },
      data: { processedAt: new Date(), caseId: record.id },
    });

    const { incident } = await this.detector.syncIncident(merchantId, event.occurredAt);
    if (incident) {
      await this.detector.attachCase(incident.id, record.id);
    }

    // DIAGNOSE. Still inline: it is fast, deterministic for four cases in five,
    // and a case that arrives undiagnosed cannot be planned for. A diagnosis
    // failure must never lose the case — an undiagnosed case is recoverable, a
    // dropped one is not.
    let diagnosis: DiagnosisSummary | undefined;
    try {
      const result = await this.diagnoser.diagnose(record.id);
      diagnosis = {
        rootCause: result.rootCause,
        confidence: result.confidence,
        method: result.method,
        escalated: result.escalated,
      };

    } catch (error) {
      this.logger.error(
        `Case ${toCaseRef(record.id)} opened but diagnosis failed: ${(error as Error).message}`,
      );
    }

    // PLAN AND ACT — queued, never inline. The webhook is answered as soon as
    // the case exists; everything that contacts a customer happens on the
    // queue, where it can be delayed, retried and cancelled. An escalated case
    // is left alone: it is waiting on a person, not on a schedule.
    if (diagnosis && !diagnosis.escalated) {
      try {
        await this.executor.scheduleFirstStep(record.id);
      } catch (error) {
        // The case is committed and the delivery is acknowledged; only the
        // job is missing, and the reconciler puts it back (D-131). Said in
        // its own words, because "diagnosis failed" sent the first outage
        // investigation to the wrong module (B-57).
        this.logger.error(
          `Case ${toCaseRef(record.id)} opened but its first step could not be queued — ` +
            `the reconciler will schedule it: ${(error as Error).message}`,
        );
      }
    }

    return { status: "accepted", caseId: record.id, caseRef: toCaseRef(record.id), diagnosis };
  }

  /**
   * A successful payment. It opens nothing, but the detector counts it — the
   * denominator is what turns a run of failures into a measurable dip.
   */
  async recordSuccess(input: {
    eventId: string;
    eventType: string;
    at?: Date;
    method?: string | null;
    bank?: string | null;
    raw: unknown;
  }): Promise<IngestOutcome> {
    const merchantId = await this.resolveMerchantId();

    const claimed = await this.claim({
      eventId: input.eventId,
      source: "razorpay",
      eventType: input.eventType,
      raw: input.raw,
    } as NormalizedEvent);

    if (!claimed.proceed) {
      return { status: "duplicate", caseRef: null };
    }

    await this.detector.recordOutcome({
      merchantId,
      success: true,
      at: input.at,
      method: input.method,
      bank: input.bank,
    });

    await this.prisma.webhookEvent.update({
      where: { eventId: input.eventId },
      data: { processedAt: new Date() },
    });

    await this.detector.syncIncident(merchantId, input.at ?? new Date());

    return { status: "recorded", outcome: "success" };
  }

  /**
   * The money arrived.
   *
   * Until this existed the only way a case could recover was a silent retry
   * capturing — which meant every message the agent sent was, structurally,
   * incapable of getting anything back. A customer paying from the link in a
   * WhatsApp nudge is the ordinary case, not an edge one, and it arrives as a
   * `payment.captured` webhook against the order the case was opened from.
   * Stage 10 points the real webhook here; the simulator already does.
   *
   * Deduped on the event id like every other delivery, because a payment
   * recorded twice is revenue counted twice, and that is the one arithmetic
   * error an evidence report cannot survive.
   */
  async recordPayment(input: PaymentArrival): Promise<IngestOutcome> {
    const claimed = await this.claim({
      eventId: input.eventId,
      source: input.source ?? "simulator",
      eventType: "payment.captured",
      raw: input.raw ?? input,
    } as NormalizedEvent);

    if (!claimed.proceed) {
      return { status: "duplicate", caseRef: claimed.caseId ? toCaseRef(claimed.caseId) : null };
    }

    const record = input.caseId
      ? await this.prisma.case.findUnique({ where: { id: input.caseId } })
      : await this.prisma.case.findFirst({
          where: { originId: input.originId, stage: { not: "recovered" } },
          orderBy: { createdAt: "desc" },
        });

    if (!record) {
      await this.prisma.webhookEvent.update({
        where: { eventId: input.eventId },
        data: { processedAt: this.clock.now() },
      });
      return { status: "ignored", reason: "No open case matches this payment" };
    }

    const merchantId = record.merchantId;
    await this.detector.recordOutcome({ merchantId, success: true, at: input.at });

    if (record.stage === "recovered") {
      await this.prisma.webhookEvent.update({
        where: { eventId: input.eventId },
        data: { processedAt: this.clock.now(), caseId: record.id },
      });
      return { status: "duplicate", caseRef: toCaseRef(record.id) };
    }

    const at = input.at ?? this.clock.now();

    await this.cases.transition(
      record.id,
      "recovered",
      {
        kind: "RECOVERED",
        occurredAt: at,
        title: `Recovered ${rupees(input.amountPaise)} rupees`,
        summary: `${input.via ?? "Paid from the recovery link"} · ${input.reference}`,
        badge: { label: "recovered", tone: "recovered" },
        body: {
          type: "facts",
          rows: [
            {
              label: "Amount",
              value: `${rupees(input.amountPaise)} rupees`,
              mono: true,
              tone: "recovered",
            },
            { label: "Payment", value: input.reference, mono: true },
            { label: "Against", value: record.originId ?? "—", mono: true },
            { label: "Arrived", value: input.via ?? "Recovery link" },
            {
              label: "Attempts used",
              value: `${record.attemptsUsed} of ${record.attemptCap}`,
              mono: true,
            },
          ],
        } as unknown as Prisma.InputJsonValue,
      },
      { recoveredAmountPaise: input.amountPaise },
    );

    // A promise the customer actually kept is resolved by the payment, not by
    // the follow-up job discovering it later.
    await this.prisma.paymentPromise.updateMany({
      where: { caseId: record.id, status: "PENDING" },
      data: { status: "KEPT", resolvedAt: at },
    });

    await cancelCaseWork(this.queue, this.prisma, record.id);

    await this.prisma.webhookEvent.update({
      where: { eventId: input.eventId },
      data: { processedAt: this.clock.now(), caseId: record.id },
    });

    this.logger.log(`${toCaseRef(record.id)} RECOVERED ${rupees(input.amountPaise)} rupees`);

    return {
      status: "recovered",
      caseId: record.id,
      caseRef: toCaseRef(record.id),
      amountPaise: input.amountPaise,
    };
  }

  /**
   * Claims the event id, or reports that someone already has it.
   *
   * The claim behaves as a lease. An unfinished claim younger than
   * STALE_CLAIM_MS belongs to an attempt that is still running — a concurrent
   * redelivery, which must back off. An unfinished claim older than that
   * belonged to an attempt that died, so the redelivery is allowed to take over
   * rather than leaving the case stranded forever.
   *
   * Without the age check, "unfinished" alone cannot tell a crash from a
   * neighbour mid-flight, and both duplicates proceed.
   */
  private async claim(event: NormalizedEvent): Promise<{ proceed: boolean; caseId?: number }> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          eventId: event.eventId,
          source: event.source,
          eventType: event.eventType,
          payload: event.raw as Prisma.InputJsonValue,
        },
      });
      return { proceed: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.prisma.webhookEvent.findUnique({
        where: { eventId: event.eventId },
      });

      if (existing && !existing.processedAt) {
        const age = Date.now() - existing.receivedAt.getTime();

        if (age > STALE_CLAIM_MS) {
          this.logger.warn(
            `Event ${event.eventId} was claimed ${Math.round(age / 1000)}s ago and never finished; taking over`,
          );
          return { proceed: true };
        }

        this.logger.log(`Event ${event.eventId} is already being processed; backing off`);
      }

      return { proceed: false, caseId: existing?.caseId ?? undefined };
    }
  }

  /** Stores an event this product does not act on, so the provider stops retrying it. */
  async acknowledgeUnhandled(
    eventId: string,
    source: string,
    eventType: string,
    raw: unknown,
  ): Promise<IngestOutcome> {
    await this.prisma.webhookEvent
      .create({
        data: {
          eventId,
          source,
          eventType,
          payload: raw as Prisma.InputJsonValue,
          processedAt: new Date(),
        },
      })
      .catch((error) => {
        if (!isUniqueViolation(error)) throw error;
      });

    return { status: "ignored", reason: `No playbook is opened by "${eventType}"` };
  }

  normalizeSimEvent(dto: SimEventDto): NormalizedEvent {
    return {
      eventId: dto.eventId ?? `sim_${randomUUID()}`,
      source: "simulator",
      eventType: dto.eventType ?? `sim.${dto.caseType.toLowerCase()}`,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      caseType: dto.caseType,
      amountPaise: dto.amountPaise,
      currency: dto.currency ?? "INR",
      origin: dto.origin,
      customer: dto.customer,
      failure: dto.failure,
      instrument: dto.instrument,
      deadlineAt: dto.deadlineAt ? new Date(dto.deadlineAt) : undefined,
      raw: dto,
    };
  }

  /** Single-tenant by design (PRD 6.1): there is exactly one merchant to attribute to. */
  private async resolveMerchantId(): Promise<string> {
    const merchant = await this.prisma.merchant.findFirst({ orderBy: { createdAt: "asc" } });

    if (!merchant) {
      throw new NotFoundException({ error: "No merchant is seeded; run `npm run db:seed`." });
    }

    return merchant.id;
  }
}

const rupees = (paise: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100));
