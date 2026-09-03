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

export type OverrideKind = "pause" | "resume" | "escalate" | "resolve-external" | "call";

/** The ledger action each override writes, copied from the frontend's map. */
const LEDGER_ACTION: Record<OverrideKind, string> = {
  pause: "AGENT_PAUSED_BY_HUMAN",
  resume: "AGENT_RESUMED_BY_HUMAN",
  escalate: "ESCALATED_BY_HUMAN",
  call: "CALL_REQUESTED_BY_HUMAN",
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
    /**
     * A forced call: the merchant has been shown what is blocking it and said
     * go anyway (D-160). Ignored for every other override — the other four do
     * not pass through the gate, so there is nothing for them to override.
     */
    force = false,
    /**
     * The checks that were objecting when the merchant pressed through, read
     * off a dry run of the gate before anything moved. Named on the ledger row
     * so "forced" says what it was forced past.
     */
    waived: string[] = [],
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

    // A closed case has nothing to resume into. The flag would clear and the
    // stage would not move — the machine allows no way out of `halted` or
    // `exhausted` except a human taking the case — so the click read as a
    // resume that did nothing (B-89). Closes now drop the hold themselves; this
    // catches a row closed before they did, and names the way back.
    if (kind === "resume" && (record.stage === "halted" || record.stage === "exhausted")) {
      const message = `${toCaseRef(caseId)} is ${record.stage} — the agent is closed to it. Use "Escalate to me", then approve the handover with "work it again from the start" to reopen the case.`;
      throw new BadRequestException({ error: message, message });
    }

    if (kind === "pause" && record.pausedAt !== null) {
      throw new BadRequestException({ error: `${toCaseRef(caseId)} is already paused.` });
    }

    // A call is asked for, not made: it goes through the planner and the gate
    // like any rung, so a paused or closed case has nothing to call about (D-145).
    // Stage is read before the pause flag, because escalating also sets
    // `pausedAt` — and "resume it first" is a confusing thing to tell somebody
    // who handed the case to themselves rather than pausing it.
    if (kind === "call" && (record.stage === "halted" || record.stage === "exhausted")) {
      throw new BadRequestException({
        error: `${toCaseRef(caseId)} is ${record.stage} — the agent has stopped working it. Raise the attempt cap in Policies if it should keep going.`,
        message: `${toCaseRef(caseId)} is ${record.stage}; the agent no longer works it.`,
      });
    }
    // Taking a halted case is allowed (B-86), but not when the customer is the
    // reason it halted. An opt-out is theirs, and a merchant reopening the case
    // to work it would be reopening it to contact somebody who said STOP — the
    // gate would refuse every send anyway, so the only thing this would produce
    // is a case that looks workable and is not.
    if (kind === "escalate" && record.stage === "halted" && record.customer.optedOutAt !== null) {
      const message = `${toCaseRef(caseId)} halted because this customer replied STOP. The case cannot be taken back on — an opt-out is the customer's, not the merchant's.`;
      throw new BadRequestException({ error: message, message });
    }

    // The one bound the override does not lift, refused here rather than in the
    // gate so the merchant is told at the click instead of watching a call
    // vanish into a queue. `UNWAIVABLE_CHECKS` is the same rule stated where
    // the evaluation happens; this is it stated where the button is.
    if (kind === "call" && force && record.customer.optedOutAt !== null) {
      const message = `${toCaseRef(caseId)} — this customer replied STOP. An opt-out is the customer's, not the merchant's, and no override lifts it.`;
      throw new BadRequestException({ error: message, message });
    }

    if (kind === "call" && record.pausedAt !== null) {
      throw new BadRequestException({
        error: `${toCaseRef(caseId)} is paused — resume it before asking Boa to call.`,
        message: `${toCaseRef(caseId)} is paused — resume it before asking Boa to call.`,
      });
    }

    // Escalating IS the stage move. If the machine refuses it, there is nothing
    // left for the override to do, and writing the ledger row anyway would put
    // "a human took this case" on a chain beside a case that never moved — two
    // surfaces disagreeing about one fact, which is the thing ADR-2 exists to
    // prevent (B-75). Refuse before anything is written.
    if (
      kind === "escalate" &&
      record.stage !== "escalated" &&
      !this.machine.canTransition(record.stage, "escalated")
    ) {
      throw new BadRequestException({
        error: `${toCaseRef(caseId)} is ${record.stage} and cannot be handed to a human from there.`,
        message: `${toCaseRef(caseId)} is ${record.stage} and cannot be handed to a human from there.`,
      });
    }

    const at = this.clock.now();
    const forced = kind === "call" && force;
    // The action the ledger row will carry, so the log line, the socket frame
    // and the response all name the same thing the chain does.
    const ledgerAction = forced ? "CALL_FORCED_BY_HUMAN" : LEDGER_ACTION[kind];
    const detail = forced
      ? `Call forced by ${by}${note ? ` · ${note}` : ""}`
      : this.detailFor(kind, by, note);

    // Everything the override changes lands in one transaction with the ledger
    // row that witnesses it, for the same reason a case event does (ADR-9).
    const row = await this.prisma.transaction(async (tx) => {
      await tx.case.update({
        where: { id: caseId },
        data: { pausedAt: kind === "resume" ? null : kind === "call" ? record.pausedAt : at },
      });

      return this.audit.append(tx, {
        merchantId,
        chain: toCaseRef(caseId),
        caseId,
        actor: "HUMAN",
        action: ledgerAction,
        detail,
        at,
        payload: {
          case_id: toCaseRef(caseId),
          override: ledgerAction,
          by,
          stage_at_override: record.stage,
          ...(note ? { note } : {}),
          // What was stepped over, by name. A forced call that recorded only
          // "forced" would be the same empty claim as a verification button
          // that hashes nothing (B-81).
          ...(forced ? { waived: waived.length > 0 ? waived : ["nothing — the gate had no objection"] } : {}),
          effect: forced ? FORCED_CALL_EFFECT : EFFECT[kind],
        },
      });
    });

    // Outside the transaction, and after it: cancelling a job is not
    // transactional — a rolled-back write cannot un-cancel a queue entry, so
    // the cancellation must follow the commit rather than race it.
    if (kind !== "resume") {
      await cancelCaseWork(this.queue, this.prisma, caseId);
    }

    // The requested call is the case's next step, now. The executor plans the
    // voice rung and the gate answers — quiet hours, opt-out and the one-call
    // cap apply exactly as they would to a rung the ladder chose (D-145).
    if (kind === "call") {
      await this.queue.enqueue(
        {
          kind: "case.step",
          caseId,
          jobId: `case:${caseId}:step:${record.attemptsUsed}`,
          reason: force ? `Call forced by ${by}` : `Call requested by ${by}`,
          expectAttempt: record.attemptsUsed,
          channel: "VOICE",
          ...(force ? { force: { by } } : {}),
        },
        { delayMs: 0 },
      );
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

    // Taking a case is only half an act: the agent stops, and then somebody has
    // to say whether it starts again. Until D-151 nobody was ever asked — the
    // case sat in `escalated` and the queue a merchant reads stayed empty — so
    // the handover now raises its own card. Over the queue rather than by
    // calling `ApprovalsService`, because `cases` may not depend on `approvals`
    // without a `forwardRef`, and the one-way arrow is what keeps "nothing
    // reaches a customer except through the Executor" true.
    if (kind === "escalate") {
      await this.queue.enqueue(
        {
          kind: "case.handover",
          caseId,
          jobId: `case:${caseId}:handover:${record.attemptsUsed}`,
          reason: `Taken from the Control Tower by ${by}${note ? ` · ${note}` : ""}`,
        },
        { delayMs: 0 },
      );
    }

    const after = await this.prisma.case.findUniqueOrThrow({ where: { id: caseId } });

    this.domain.publish({
      name: "case.updated",
      merchantId,
      caseId: toCaseRef(caseId),
      stage: after.stage,
      kind: ledgerAction,
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
        kind: kind === "resume" || kind === "call" ? "POLICY" : kind === "escalate" ? "ESCALATE" : "HALT",
        actor: "POLICY",
        caseId: toCaseRef(caseId),
        title: `${TITLE[kind]} ${toCaseRef(caseId)}`,
        meta: detail,
        time: istClock(at),
      },
    });

    this.domain.publish({ name: "kpi.updated", merchantId });

    this.logger.log(`${toCaseRef(caseId)} ${ledgerAction} by ${by}`);

    return { ok: true, override: ledgerAction, stage: after.stage, row };
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
  call: "Call requested on",
  "resolve-external": "Closed outside Tugboat:",
};

const DETAIL: Record<OverrideKind, string> = {
  pause: "Agent paused",
  resume: "Agent resumed",
  escalate: "Taken over",
  call: "Call requested",
  "resolve-external": "Resolved externally",
};

/** What a forced call actually does, for the ledger row's `effect`. */
const FORCED_CALL_EFFECT =
  "Boa calls now — the cool-down is waived by a named human and recorded as waived; quiet hours, the opt-out, the caps and every other bound still apply";

const EFFECT: Record<OverrideKind, string> = {
  pause: "Every outbound action is refused at the gate until a human resumes it; queued work cancelled",
  resume: "The agent works the case again from its current stage",
  escalate: "The case is escalated and held by a human; queued work cancelled",
  call: "Boa calls the customer at the next moment the gate allows — quiet hours, opt-out and the one-call cap still apply",
  "resolve-external": "The case is closed to the agent — settled somewhere other than Tugboat",
};
