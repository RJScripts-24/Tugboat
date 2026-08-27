import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { CaseStage, CaseType, Prisma } from "@prisma/client";

import { CaseStateMachine } from "../agent-core/case.state-machine";
import { toCaseRef } from "../common/case-ref";
import { maskEmail, maskPhone } from "../common/mask";
import type { NormalizedEvent } from "../ingestion/normalized-event";
import { PrismaService } from "../prisma/prisma.service";
import { narratedCases } from "./narrated";
import {
  CaseEventsService,
  withSeqRetry,
  type AppendEventInput,
} from "./case-events.service";

const CASE_INCLUDE = { customer: true } satisfies Prisma.CaseInclude;

export type CaseWithCustomer = Prisma.CaseGetPayload<{ include: typeof CASE_INCLUDE }>;

export type CaseFilters = {
  stage?: CaseStage[];
  type?: CaseType[];
  rootCause?: string[];
  search?: string;
  minPaise?: number;
  maxPaise?: number;
  skip?: number;
  take?: number;
};

@Injectable()
export class CasesService {
  private readonly logger = new Logger(CasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: CaseEventsService,
    private readonly machine: CaseStateMachine,
  ) {}

  /**
   * Opens a case from a normalized event, or returns the existing one if this
   * origin object already has a case. Idempotency here is a second line behind
   * webhook de-duplication: a redelivery that somehow slipped past the dedupe
   * table still cannot produce two cases for one failed payment.
   */
  async openFromEvent(merchantId: string, event: NormalizedEvent): Promise<CaseWithCustomer> {
    // Scoped to cases still in flight: a subscription that bounces again next
    // month is genuinely a new case, so matching every case ever opened against
    // that subscription id would silently swallow the second failure.
    const existing = await this.prisma.case.findFirst({
      where: {
        merchantId,
        originId: event.origin.id,
        stage: { notIn: ["recovered", "halted", "exhausted"] },
      },
      include: CASE_INCLUDE,
    });

    if (existing) {
      this.logger.log(`Event ${event.eventId} maps to existing case ${existing.id}`);
      return existing;
    }

    const customer = await this.resolveCustomer(merchantId, event);

    return this.withSeqRetry(() =>
      this.prisma.transaction(async (tx) => {
        const record = await tx.case.create({
          data: {
            merchantId,
            customerId: customer.id,
            type: event.caseType,
            amountPaise: event.amountPaise,
            currency: event.currency,
            stage: "detected",
            originKind: event.origin.kind,
            originId: event.origin.id,
            originRef: event.origin.reference,
            // The gateway's account of the failure is stored on the case, not
            // only inside the detection event's body, because the Diagnoser
            // reads it back as structured input rather than as display text.
            failureCode: event.failure?.code,
            failureReason: event.failure?.reason,
            failureSource: event.failure?.source,
            instrument: event.instrument,
            deadlineAt: event.deadlineAt,
            createdAt: event.occurredAt,
            simRunId: event.simRunId,
            simArm: event.simRunId ? "tugboat" : undefined,
          },
        });

        await this.events.append(tx, {
          caseId: record.id,
          kind: "DETECTED",
          occurredAt: event.occurredAt,
          title: detectionTitle(event.caseType),
          summary: event.failure?.reason
            ? `${event.failure.code ?? "ERROR"} · ${event.failure.reason}`
            : `${event.origin.kind} · no gateway error to read`,
          body: {
            type: "facts",
            rows: detectionRows(event),
          },
        });

        return tx.case.findUniqueOrThrow({ where: { id: record.id }, include: CASE_INCLUDE });
      }),
    );
  }

  /**
   * Moves a case to a new stage and records why, in one transaction.
   *
   * The two writes are inseparable by design (ADR-2): a stage change with no
   * event is a case whose history has a hole, and an event with no stage change
   * is a timeline that describes something that did not happen.
   */
  async transition(
    caseId: number,
    to: CaseStage,
    event: Omit<AppendEventInput, "caseId">,
    data: Prisma.CaseUpdateInput = {},
  ): Promise<CaseWithCustomer> {
    return this.withSeqRetry(() =>
      this.prisma.transaction(async (tx) => {
        const current = await tx.case.findUnique({ where: { id: caseId } });
        if (!current) {
          throw new NotFoundException({ error: `Case ${caseId} not found.` });
        }

        this.machine.assertTransition(current.stage, to);

        await tx.case.update({ where: { id: caseId }, data: { ...data, stage: to } });
        await this.events.append(tx, { ...event, caseId });

        return tx.case.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
      }),
    );
  }

  /**
   * Records what happened, moving the case only if it is not already there.
   *
   * A send that leaves a case waiting is the ordinary outcome, and the case is
   * usually somewhere else when it happens — but not always. An approved action
   * whose release was deferred by quiet hours has already been parked in
   * `waiting`, so when the release finally goes through, the honest description
   * of the result is "still waiting" and `transition` would refuse it as an
   * illegal move to itself. Refusing there loses the send from the timeline and
   * the spend from the case, which is the opposite of what the state machine is
   * protecting (B-34).
   *
   * Deliberately not a change to `transition`. A stage moving to itself is a
   * bug almost everywhere else, and it should keep throwing there.
   */
  async settle(
    caseId: number,
    to: CaseStage,
    event: Omit<AppendEventInput, "caseId">,
    data: Prisma.CaseUpdateInput = {},
  ): Promise<void> {
    const current = await this.prisma.case.findUnique({
      where: { id: caseId },
      select: { stage: true },
    });

    if (!current) throw new NotFoundException({ error: `Case ${caseId} not found.` });

    if (current.stage !== to) {
      await this.transition(caseId, to, event, data);
      return;
    }

    await this.withSeqRetry(() =>
      this.prisma.transaction(async (tx) => {
        await tx.case.update({ where: { id: caseId }, data });
        await this.events.append(tx, { ...event, caseId });
      }),
    );
  }

  /**
   * Moves a case without writing a new event.
   *
   * Used only where the explanation is already on the timeline — a deferral is
   * explained by the PolicyGate's own POLICY_CHECK entry, and the wire
   * vocabulary has no event kind for "scheduled for later" (build prompt 3.2).
   * Inventing one would break the contract with the UI; writing a second event
   * that restates the check would be duplication rather than evidence. The
   * reason is logged so the transition is still traceable.
   */
  async moveStage(caseId: number, to: CaseStage, reason: string): Promise<void> {
    const current = await this.prisma.case.findUnique({ where: { id: caseId } });
    if (!current) throw new NotFoundException({ error: `Case ${caseId} not found.` });
    if (current.stage === to) return;

    this.machine.assertTransition(current.stage, to);
    await this.prisma.case.update({ where: { id: caseId }, data: { stage: to } });
    this.logger.log(`${toCaseRef(caseId)} ${current.stage} -> ${to} (${reason})`);
  }

  /** Appends an event that explains no stage change of its own. */
  async appendEvent(caseId: number, event: Omit<AppendEventInput, "caseId">): Promise<void> {
    await this.withSeqRetry(() =>
      this.prisma.transaction((tx) => this.events.append(tx, { ...event, caseId })),
    );
  }

  async list(merchantId: string, filters: CaseFilters = {}) {
    const where: Prisma.CaseWhereInput = {
      // Live cases and the promoted batch — never a run still in the Lab (D-120).
      ...narratedCases(merchantId),
      ...(filters.stage?.length ? { stage: { in: filters.stage } } : {}),
      ...(filters.type?.length ? { type: { in: filters.type } } : {}),
      ...(filters.rootCause?.length
        ? { rootCause: { in: filters.rootCause as Prisma.EnumRootCauseFilter["in"] } }
        : {}),
      ...(filters.minPaise !== undefined || filters.maxPaise !== undefined
        ? { amountPaise: { gte: filters.minPaise, lte: filters.maxPaise } }
        : {}),
      ...(filters.search
        ? {
            // Under AND, because the narrated clause above is itself an OR and a
            // second top-level OR would replace it rather than combine with it.
            AND: [
              {
                OR: [
                  { customer: { name: { contains: filters.search, mode: "insensitive" } } },
                  { originId: { contains: filters.search, mode: "insensitive" } },
                ],
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.case.findMany({
        where,
        include: CASE_INCLUDE,
        orderBy: { updatedAt: "desc" },
        skip: filters.skip ?? 0,
        take: filters.take ?? 100,
      }),
      this.prisma.case.count({ where }),
    ]);

    return { rows, total };
  }

  async findOne(merchantId: string, caseId: number) {
    const record = await this.prisma.case.findFirst({
      where: { id: caseId, merchantId },
      include: {
        customer: true,
        events: { orderBy: { seq: "asc" } },
        actions: { orderBy: { createdAt: "asc" } },
        promises: true,
      },
    });

    if (!record) {
      throw new NotFoundException({ error: `Case C-${caseId} not found.` });
    }

    return record;
  }

  /**
   * What thinking about this case has cost.
   *
   * Read from `llm_calls` rather than counted on the case, because the same
   * rule applies here as to every other figure in this product: a number kept
   * beside the rows it summarises is a number that eventually disagrees with
   * them. Zero calls is the ordinary answer — four cases in five are diagnosed
   * by the rules table and never reach a model (ADR-5), and the outcome card
   * saying so is the architecture arguing for itself.
   */
  async inferenceSpend(caseId: number): Promise<{ calls: number; tokens: number }> {
    const spend = await this.prisma.llmCall.aggregate({
      where: { caseId },
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true },
    });

    return {
      calls: spend._count._all,
      tokens: (spend._sum.tokensIn ?? 0) + (spend._sum.tokensOut ?? 0),
    };
  }

  /** How many cases the Tower is narrating, for the walk control's "of 214". */
  count(merchantId: string): Promise<number> {
    return this.prisma.case.count({ where: narratedCases(merchantId) });
  }

  /** Neighbouring case ids, for the prev/next control on Case Detail. */
  async neighbours(merchantId: string, caseId: number) {
    const [prev, next] = await Promise.all([
      this.prisma.case.findFirst({
        where: { ...narratedCases(merchantId), id: { lt: caseId } },
        orderBy: { id: "desc" },
        select: { id: true },
      }),
      this.prisma.case.findFirst({
        where: { ...narratedCases(merchantId), id: { gt: caseId } },
        orderBy: { id: "asc" },
        select: { id: true },
      }),
    ]);

    return { prev: prev?.id ?? null, next: next?.id ?? null };
  }

  private async resolveCustomer(merchantId: string, event: NormalizedEvent) {
    const { customer } = event;

    const existing = await this.prisma.customer.findFirst({
      where: {
        merchantId,
        OR: [
          ...(customer.email ? [{ email: customer.email }] : []),
          ...(customer.phone ? [{ phone: customer.phone }] : []),
        ],
      },
    });

    // A customer known by one contact who arrives with the other keeps both:
    // a row matched by phone with no email would skip every email rung for
    // ever, and narrate it as the customer's choice (B-69). Existing contacts
    // are never overwritten — the newer webhook is not the truer one.
    if (existing) {
      const fill = {
        ...(!existing.email && customer.email
          ? { email: customer.email, maskedEmail: maskEmail(customer.email) }
          : {}),
        ...(!existing.phone && customer.phone
          ? { phone: customer.phone, maskedPhone: maskPhone(customer.phone) }
          : {}),
      };
      if (Object.keys(fill).length === 0) return existing;
      return this.prisma.customer.update({ where: { id: existing.id }, data: fill });
    }

    return this.prisma.customer.create({
      data: {
        merchantId,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        maskedEmail: customer.email ? maskEmail(customer.email) : null,
        maskedPhone: customer.phone ? maskPhone(customer.phone) : null,
        languagePref: customer.languagePref ?? "en-IN",
        segment: customer.segment ?? "B2C",
      },
    });
  }

  private async withSeqRetry<T>(run: () => Promise<T>): Promise<T> {
    return withSeqRetry(run, {
      onRetry: (attempt) => this.logger.warn(`Event sequence collision; retrying (attempt ${attempt})`),
    });
  }
}

function detectionTitle(type: CaseType): string {
  switch (type) {
    case "PAYMENT_FAILED":
      return "Payment failed";
    case "CHECKOUT_ABANDONED":
      return "Checkout abandoned";
    case "MANDATE_FAILED":
      return "Mandate debit failed";
    default:
      return "Invoice past due";
  }
}

function detectionRows(event: NormalizedEvent) {
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: "Signal", value: detectionTitle(event.caseType) },
    { label: event.origin.kind, value: event.origin.id, mono: true },
    { label: "Amount", value: `₹${Math.round(event.amountPaise / 100)}`, mono: true },
    { label: "Source", value: event.source },
  ];

  if (event.failure?.code) {
    rows.push({ label: "Error code", value: event.failure.code, mono: true });
  }
  if (event.failure?.reason) {
    rows.push({ label: "Reason", value: event.failure.reason, mono: true });
  }
  if (event.failure?.source) {
    rows.push({ label: "Reported by", value: event.failure.source });
  }
  if (event.instrument) {
    rows.push({ label: "Instrument", value: event.instrument });
  }

  return rows;
}
