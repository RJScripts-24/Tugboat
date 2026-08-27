import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";

import { AuditWriterService } from "../audit/audit-writer.service";
import { toCaseRef } from "../common/case-ref";
import { ClockService } from "../common/clock.service";
import { DomainEventsService } from "../common/domain-events.service";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE, type ActionQueue } from "../queue/action-queue.interface";
import { cancelCaseWork } from "../queue/cancel-case-work";
import { CaseStateMachine } from "../agent-core/case.state-machine";
import { istClock } from "./case-activity";
import { CasesService } from "./cases.service";

/**
 * The four things a merchant can do to a case that Boa cannot argue with.
 *
 * The names are the frontend's own (`OVERRIDE_ACTIONS` in `lib/event-store.ts`)
 * and so is the model: an override is a **ledger row, not a timeline event**.
 * That is not a shortcut around the append-only rule, it is the rule applied
 * correctly. `case_events` is the story of the recovery — what was detected,
 * diagnosed, checked, sent, replied to. "A human took this off the agent" is
 * not a step in that story; it is a fact about who was holding it, and the
 * ledger is where facts about who did what live. The `EventKind` vocabulary is
 * fixed (build prompt §3.2) and has no member for it, and inventing one would
 * change a contract to avoid choosing the right place (D-108).
 *
 * The browser has folded these rows into a case's state since the mock layer
 * existed (`caseStateOf`). What Stage 9 adds is that the fold now has teeth: a
 * pause writes `cases.pausedAt`, the PolicyGate refuses every outbound action
 * while it is set, and the queued work is cancelled rather than left to fire at
 * a customer whose merchant just said stop.
 */

export type OverrideKind = "pause" | "resume" | "escalate" | "resolve-external";

/** The ledger action each override writes, copied from the frontend's map. */
const LEDGER_ACTION: Record<OverrideKind, string> = {
  pause: "AGENT_PAUSED_BY_HUMAN",
  resume: "AGENT_RESUMED_BY_HUMAN",
  escalate: "ESCALATED_BY_HUMAN",
  "resolve-external": "RESOLVED_EXTERNALLY",
};

@Injectable()
export class CaseOverridesService {
  private readonly logger = new Logger(CaseOverridesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cases: CasesService,
    private readonly audit: AuditWriterService,
    private readonly clock: ClockService,
    private readonly domain: DomainEventsService,
    private readonly machine: CaseStateMachine,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
  ) {}

  async apply(
    merchantId: string,
    caseId: number,
    kind: OverrideKind,
    by: string,
    note: string | null,
  ) {
    const record = await this.prisma.case.findFirst({
      where: { id: caseId, merchantId },
      include: { customer: true },
    });

    if (!record) throw new NotFoundException({ error: `Case ${toCaseRef(caseId)} not found.` });

    // A recovered case is finished, and the money is not un-recovered by a
    // click. Refusing here rather than writing a row that describes nothing is
    // the same rule the state machine follows (D-23).
    if (record.stage === "recovered") {
      throw new BadRequestException({
        error: `${toCaseRef(caseId)} is already recovered — there is nothing left for a human to take over.`,
      });
    }

    if (kind === "resume" && record.pausedAt === null) {
      throw new BadRequestException({ error: `${toCaseRef(caseId)} is not paused.` });
    }

    if (kind === "pause" && record.pausedAt !== null) {
      throw new BadRequestException({ error: `${toCaseRef(caseId)} is already paused.` });
    }

    const at = this.clock.now();
    const detail = this.detailFor(kind, by, note);

    // Everything the override changes lands in one transaction with the ledger
    // row that witnesses it, for the same reason a case event does (ADR-9).
    const row = await this.prisma.transaction(async (tx) => {
      await tx.case.update({
        where: { id: caseId },
        data: { pausedAt: kind === "resume" ? null : at },
      });

      return this.audit.append(tx, {
        merchantId,
        chain: toCaseRef(caseId),
        caseId,
        actor: "HUMAN",
        action: LEDGER_ACTION[kind],
        detail,
        at,
        payload: {
          case_id: toCaseRef(caseId),
          override: LEDGER_ACTION[kind],
          by,
          stage_at_override: record.stage,
          ...(note ? { note } : {}),
          effect: EFFECT[kind],
        },
      });
    });

    // Outside the transaction, and after it: cancelling a job is not
    // transactional — a rolled-back write cannot un-cancel a queue entry, so
    // the cancellation must follow the commit rather than race it.
    if (kind !== "resume") {
      await cancelCaseWork(this.queue, this.prisma, caseId);
    }

    // The stage moves only where the machine allows it. An exhausted case that
    // a merchant settles by phone stays exhausted, and the ledger row is what
    // records the ending — bending the transition table to fit a button would
    // make the nine-stage machine a suggestion (D-108).
    const target =
      kind === "escalate" ? "escalated" : kind === "resolve-external" ? "halted" : null;

    if (target && record.stage !== target && this.machine.canTransition(record.stage, target)) {
      await this.cases.moveStage(caseId, target, `${DETAIL[kind].toLowerCase()} by ${by}`);
    }

    const after = await this.prisma.case.findUniqueOrThrow({ where: { id: caseId } });

    this.domain.publish({
      name: "case.updated",
      merchantId,
      caseId: toCaseRef(caseId),
      stage: after.stage,
      kind: LEDGER_ACTION[kind],
      recoveredPaise: after.recoveredAmountPaise,
      attempts: after.attemptsUsed,
    });

    this.domain.publish({
      name: "activity.new",
      merchantId,
      entry: {
        id: `ov-${row.id}`,
        // A human taking a case off the agent reads as a stop on the feed,
        // except for a resume, which is the agent being handed it back.
        kind: kind === "resume" ? "POLICY" : kind === "escalate" ? "ESCALATE" : "HALT",
        actor: "POLICY",
        caseId: toCaseRef(caseId),
        title: `${TITLE[kind]} ${toCaseRef(caseId)}`,
        meta: detail,
        time: istClock(at),
      },
    });

    this.domain.publish({ name: "kpi.updated", merchantId });

    this.logger.log(`${toCaseRef(caseId)} ${LEDGER_ACTION[kind]} by ${by}`);

    return { ok: true, override: LEDGER_ACTION[kind], stage: after.stage, row };
  }

  private detailFor(kind: OverrideKind, by: string, note: string | null): string {
    const base = `${DETAIL[kind]} by ${by}`;
    return note ? `${base} · ${note}` : base;
  }
}

const TITLE: Record<OverrideKind, string> = {
  pause: "Agent paused on",
  resume: "Agent resumed on",
  escalate: "Taken over by a human on",
  "resolve-external": "Closed outside Tugboat:",
};

const DETAIL: Record<OverrideKind, string> = {
  pause: "Agent paused",
  resume: "Agent resumed",
  escalate: "Taken over",
  "resolve-external": "Resolved externally",
};

const EFFECT: Record<OverrideKind, string> = {
  pause: "Every outbound action is refused at the gate until a human resumes it; queued work cancelled",
  resume: "The agent works the case again from its current stage",
  escalate: "The case is escalated and held by a human; queued work cancelled",
  "resolve-external": "The case is closed to the agent — settled somewhere other than Tugboat",
};
