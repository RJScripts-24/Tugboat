import { Injectable } from "@nestjs/common";
import { Prisma, type EventKind } from "@prisma/client";

import { AuditWriterService } from "../audit/audit-writer.service";
import { AUDIT_MAP, payloadFor } from "../audit/ledger-payload";
import { toCaseRef } from "../common/case-ref";
import { ClockService } from "../common/clock.service";
import { DomainEventsService } from "../common/domain-events.service";
import { toActivityEntry } from "./case-activity";

export type AppendEventInput = {
  caseId: number;
  kind: EventKind;
  title: string;
  summary: string;
  badge?: { label: string; tone: string };
  /** Shaped like the frontend's EventBody union. */
  body?: Prisma.InputJsonValue;
  occurredAt?: Date;
};

/** True for the "row already exists" error, which is how the seq race surfaces. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Retries a transaction that lost the event-sequence race.
 *
 * Sequence numbers are read-max-plus-one, so two transactions writing to the
 * same case can choose the same number; the unique index on (caseId, seq) turns
 * that into a loud failure instead of a silently reordered history, and this
 * retries the loser. It lives here rather than inside one service because
 * *every* writer of a case event needs it — the gate learned that the hard way
 * (B-16).
 */
export async function withSeqRetry<T>(
  run: () => Promise<T>,
  options: { attempts?: number; onRetry?: (attempt: number) => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isUniqueViolation(error)) throw error;
      options.onRetry?.(attempt + 1);
    }
  }
}

@Injectable()
export class CaseEventsService {
  constructor(
    private readonly audit: AuditWriterService,
    private readonly clock: ClockService,
    private readonly domain: DomainEventsService,
  ) {}

  /**
   * Appends the next event in a case's history — and its ledger row.
   *
   * Takes a transaction client rather than opening its own, because an event
   * and the state change it describes must land together or not at all (ADR-2).
   * Callers wrap both in one transaction; a caller that forgets cannot compile,
   * since there is no overload that accepts the bare client.
   *
   * The audit row goes in the same write for the same reason, one step further
   * (ADR-9, D-75): the ledger is not a listener that might miss something, it
   * is part of what writing history *is*. There is no code path that can add to
   * a case's story without adding to its evidence, and no window in which a
   * crash leaves one without the other.
   */
  async append(tx: Prisma.TransactionClient, input: AppendEventInput) {
    const { _max } = await tx.caseEvent.aggregate({
      where: { caseId: input.caseId },
      _max: { seq: true },
    });

    const occurredAt = input.occurredAt ?? this.clock.now();

    const event = await tx.caseEvent.create({
      data: {
        caseId: input.caseId,
        seq: (_max.seq ?? 0) + 1,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        badgeLabel: input.badge?.label,
        badgeTone: input.badge?.tone,
        body: input.body,
        occurredAt,
      },
    });

    const record = await tx.case.findUnique({
      where: { id: input.caseId },
      include: { customer: true },
    });

    // A case is always present here — the event is being written against it in
    // the same transaction. The guard exists so a future caller that appends
    // before the case row exists fails loudly rather than writing a ledger row
    // that references nothing.
    if (!record) {
      throw new Error(`Cannot audit an event for case ${input.caseId}: the case does not exist`);
    }

    const { actor, action } = AUDIT_MAP[input.kind];

    await this.audit.append(tx, {
      merchantId: record.merchantId,
      chain: toCaseRef(record.id),
      caseId: record.id,
      actor,
      action,
      detail: input.summary,
      at: occurredAt,
      payload: payloadFor(event, record, record.customer),
    });

    // Announced, not sent: the bus buffers all three of these until the
    // transaction commits, so a rolled-back append never reaches a browser
    // (D-100). The same choke point that guarantees every case event has a
    // ledger row now guarantees it has a feed line, and for the same reason — a
    // listener that could be forgotten is a feed that silently stops being true.
    //
    // Except inside a shifted clock frame, which is a simulation batch and not
    // this merchant's operations (D-101). A run works two hundred cases in
    // minutes; streaming them into the Control Tower's live log would put a
    // counterfactual experiment in the operational feed at three hundred lines
    // a second. The Lab narrates its own run through `sim.progress`.
    if (this.clock.shifted) return event;

    this.domain.publish({
      name: "activity.new",
      merchantId: record.merchantId,
      entry: toActivityEntry(event, record.id),
    });

    this.domain.publish({
      name: "case.updated",
      merchantId: record.merchantId,
      caseId: toCaseRef(record.id),
      stage: record.stage,
      kind: event.kind,
      recoveredPaise: record.recoveredAmountPaise,
      attempts: record.attemptsUsed,
    });

    // The KPI strip is derived from many cases at once, so this is a nudge
    // rather than a figure: the gateway coalesces the nudges and computes the
    // numbers once (D-102). Publishing a recomputed `Kpis` per event would run
    // six aggregate queries inside somebody else's transaction.
    this.domain.publish({ name: "kpi.updated", merchantId: record.merchantId });

    return event;
  }
}
