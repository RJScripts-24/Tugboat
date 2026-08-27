import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { CaseStage } from "@prisma/client";

import { toCaseRef } from "../common/case-ref";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE, type ActionQueue } from "../queue/action-queue.interface";
import { ExecutorService } from "./executor.service";

/**
 * Stages in which the agent itself owes the case a next step.
 *
 * `escalated` waits on a person and `promised` on a check-in job with its own
 * id; the closed stages owe nothing. What is left is every stage where the
 * invariant "one open case, one future job" must hold.
 */
const AGENT_OWED: readonly CaseStage[] = ["diagnosed", "intervening", "waiting"];

const FIRST_SWEEP_MS = 30_000;
const SWEEP_MS = 5 * 60_000;

/**
 * Puts back the job an open case should have and does not.
 *
 * The database is the truth about a case; the queue is a promise the agent
 * made about when it will look at it next. The promise can be lost without
 * the truth changing — Redis unreachable at the moment a webhook was
 * answered, a process killed with a job in memory, a queue obliterated by a
 * reseed — and nothing in the ordinary loop notices, because the loop only
 * ever runs from a job. A case in that state sits at "waiting" forever with a
 * stage that says the agent is on it (D-131).
 *
 * Every open case the agent owes a step is checked for its job by the id the
 * executor would have given it. Absent, the step is scheduled again through
 * the executor's own door, so the gate and the idempotency key still decide
 * what actually happens. The sweep is idle on the in-memory queue: a test or
 * a batch drains that queue itself, and work put on it here would never run.
 */
@Injectable()
export class WorkReconcilerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkReconcilerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: ExecutorService,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
  ) {}

  onApplicationBootstrap(): void {
    if (this.queue.kind !== "bullmq") return;

    const sweep = () => {
      void this.reconcile().catch((error) => {
        this.logger.error(`Reconciliation failed: ${(error as Error).message}`);
      });
    };

    this.timer = setTimeout(() => {
      sweep();
      this.timer = setInterval(sweep, SWEEP_MS);
      this.timer.unref();
    }, FIRST_SWEEP_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async reconcile(): Promise<{ examined: number; rescheduled: number[] }> {
    // Live cases only. A batch's cases are worked by the runner on its own
    // queue, and a finished batch's cases are a report, not a backlog.
    const open = await this.prisma.case.findMany({
      where: {
        simRunId: null,
        pausedAt: null,
        stage: { in: [...AGENT_OWED] },
        approvals: { none: { decision: null } },
      },
      select: { id: true, stage: true, attemptsUsed: true },
      orderBy: { id: "asc" },
    });

    const rescheduled: number[] = [];

    for (const record of open) {
      if (await this.queue.has(`case:${record.id}:step:${record.attemptsUsed}`)) continue;

      if (record.stage === "diagnosed") {
        await this.executor.scheduleFirstStep(record.id);
      } else {
        await this.executor.schedule(
          record.id,
          0,
          "Reconciled — the scheduled step for this case was missing from the queue",
        );
      }
      rescheduled.push(record.id);
    }

    if (rescheduled.length > 0) {
      this.logger.warn(
        `Rescheduled ${rescheduled.length} case(s) with no queued work: ${rescheduled
          .map(toCaseRef)
          .join(", ")}`,
      );
    }

    return { examined: open.length, rescheduled };
  }
}
