import type { PrismaService } from "../prisma/prisma.service";
import type { ActionQueue } from "./action-queue.interface";

/**
 * Drops every job still waiting on a case.
 *
 * A halt that leaves a scheduled nudge in the queue is not a halt, it is a
 * delay — and a case that has just been paid does not need another reminder
 * about the money it no longer owes. The step job ids are derived rather than
 * stored, so the whole plausible range is cancelled; cancelling an id that was
 * never scheduled is a no-op, which is why the loop can be blunt.
 *
 * Lives here rather than inside one service because three callers need it —
 * the opt-out halt, the payment that closes a case, and the rejection that
 * stands the agent down — and three copies of a cancellation loop is three
 * chances for one of them to miss the promise follow-up.
 */
export async function cancelCaseWork(
  queue: ActionQueue,
  prisma: PrismaService,
  caseId: number,
): Promise<void> {
  for (let attempt = 0; attempt <= 8; attempt += 1) {
    await queue.cancel(`case:${caseId}:step:${attempt}`);
  }

  const promises = await prisma.paymentPromise.findMany({
    where: { caseId, status: "PENDING" },
    select: { id: true },
  });

  for (const promise of promises) {
    await queue.cancel(`promise:${promise.id}`);
  }
}
