import { Injectable } from "@nestjs/common";
import { Prisma, type EventKind } from "@prisma/client";

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
  /**
   * Appends the next event in a case's history.
   *
   * Takes a transaction client rather than opening its own, because an event
   * and the state change it describes must land together or not at all (ADR-2).
   * Callers wrap both in one transaction; a caller that forgets cannot compile,
   * since there is no overload that accepts the bare client.
   */
  async append(tx: Prisma.TransactionClient, input: AppendEventInput) {
    const { _max } = await tx.caseEvent.aggregate({
      where: { caseId: input.caseId },
      _max: { seq: true },
    });

    return tx.caseEvent.create({
      data: {
        caseId: input.caseId,
        seq: (_max.seq ?? 0) + 1,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        badgeLabel: input.badge?.label,
        badgeTone: input.badge?.tone,
        body: input.body,
        occurredAt: input.occurredAt ?? new Date(),
      },
    });
  }
}
