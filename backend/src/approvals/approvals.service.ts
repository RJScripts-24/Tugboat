import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Approval, ApprovalGate, Case, Customer, Prisma } from "@prisma/client";

import { CaseEventsService, isUniqueViolation, withSeqRetry } from "../cases/case-events.service";
import { CasesService } from "../cases/cases.service";
import { OPT_OUT_LINE, ensureOptOut } from "../channels/message-copy";
import { toCaseRef } from "../common/case-ref";
import { ClockService } from "../common/clock.service";
import { narratedCases } from "../cases/narrated";
import { DomainEventsService } from "../common/domain-events.service";
import { maskedContact } from "../common/mask";
import { PolicyService } from "../policy/policy.service";
import type { PolicyChannel } from "../policy/policy-pack";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE, type ActionQueue } from "../queue/action-queue.interface";
import {
  buildAsk,
  type Ask,
  type Candidate,
  type DraftMessage,
  type PolicyChip,
  type ResumeStep,
} from "./ask-builder";
import { computeStats, type ApprovalStats } from "./approvals.stats";
import { rejectionReasonsFor } from "./rejection-reasons";

/**
 * The queue of things Boa planned, checked, and then refused to do alone.
 *
 * Two rules shape this file. A request is *written once*, at the moment the
 * gate refuses: the card an approver reads is the ask as it stood then, not one
 * rebuilt later from a case that has moved. And a decision is *not the
 * execution*: approving enqueues a release that re-runs the gate before
 * anything leaves the building, because between the click and the send the
 * customer may have opted out, the quiet window may have closed, or the case
 * may have recovered on its own.
 */

/** Rejections that leave the case to the agent, rather than closing it. */
const REJECTION_RESUMES: Record<ApprovalGate, boolean> = {
  // A refused concession is a refused *concession*: the case carries on
  // without one, which is exactly what the playbook would have done anyway.
  discount_requires_approval: true,
  // The other three are refusals to work the case at all. Continuing after one
  // would be the agent overruling the person it just asked.
  b2b_high_value: false,
  confidence_below_threshold: false,
  hardship_language: false,
  // "Don't pursue this one" is the whole question the handover gate asks, so a
  // no is an answer rather than a deferral: the case halts (D-151).
  escalated_to_human: false,
};

/** Gates whose approved action ends the case rather than resuming it. */
const APPROVAL_CLOSES: Record<ApprovalGate, boolean> = {
  discount_requires_approval: false,
  b2b_high_value: false,
  confidence_below_threshold: false,
  // A hardship message is sent once and followed by nothing — the whole point
  // of the ask is that this customer is not chased again.
  hardship_language: true,
  // A yes here is the opposite: the case goes back on the ladder.
  escalated_to_human: false,
};

export type RaiseInput = {
  caseId: number;
  gate: ApprovalGate;
  /** The rung the planner wanted when the gate refused it. */
  channel: PolicyChannel;
  concessionPaise?: number;
  discountPercent?: number;
  /**
   * Why the case stopped, in the escalation's own words. Only the handover gate
   * carries one — the other four *are* the reason, and repeating it on the card
   * would be the rule quoting itself.
   */
  reason?: string | null;
};

export type ApprovalRequestView = {
  id: string;
  caseId: string;
  gate: ApprovalGate;
  customer: string;
  segment: "B2C" | "B2B";
  caseType: Case["type"];
  rootCause: string;
  confidence: number | null;
  atRiskPaise: number;
  concessionPaise: number;
  headline: string;
  justification: string[];
  chips: PolicyChip[];
  draft: DraftMessage;
  candidates: Candidate[];
  attempts: number;
  attemptCap: number;
  contact: string;
  requestedMinutesAgo: number;
  ifApproved: string;
  ifRejected: string;
  resumeSteps: { label: string; detail: string }[];
  /**
   * The reasons the reject dialog offers for this gate. Served with the request
   * so the dialog's options and the reasons the history table can contain are
   * one list rather than two copies that drift (D-70).
   */
  rejectionReasons: string[];
};

export type DecidedApprovalView = {
  id: string;
  caseId: string;
  gate: ApprovalGate;
  decision: "approved" | "rejected";
  decidedBy: string;
  afterAttempt: number;
  headline: string;
  reason: string | null;
  requestedMinutesAgo: number;
  decidedMinutesAgo: number;
  latencySeconds: number;
};

export type ApprovalHistoryView = DecidedApprovalView & {
  customer: string;
  caseType: Case["type"];
  stage: Case["stage"];
  atRiskPaise: number;
  recoveredPaise: number;
  concessionPaise: number;
  outcome: string;
};

type ApprovalWithCase = Approval & { case: Case & { customer: Customer } };

const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100));

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cases: CasesService,
    private readonly events: CaseEventsService,
    private readonly policy: PolicyService,
    private readonly clock: ClockService,
    private readonly domain: DomainEventsService,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Raising                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Turns a `needs_approval` verdict into a request a human can answer.
   *
   * The blocked action is written as a real `actions` row in `NEEDS_APPROVAL`
   * rather than being left implicit, so the thing that was stopped and the
   * thing that is later sent are the same record. Its idempotency key names the
   * case, the gate and the attempt, which is the natural unit: a redelivered
   * step that escalates twice must produce one card, while the same gate firing
   * again on the *next* attempt is a genuinely new question.
   */
  async raise(input: RaiseInput): Promise<ApprovalWithCase> {
    const record = await this.prisma.case.findUniqueOrThrow({
      where: { id: input.caseId },
      include: { customer: true },
    });

    // A pending request and a case that is not `escalated` would be two
    // accounts of the same fact disagreeing: the queue would show work waiting
    // on a human while the pipeline showed the agent still working it. The
    // Executor transitions before it calls this, so a failure here is a bug in
    // a caller rather than a state to repair silently.
    if (record.stage !== "escalated") {
      const message = `Case ${record.id} is ${record.stage}; a request is only raised on an escalated case`;
      throw new BadRequestException({ error: message, message });
    }

    const idempotencyKey = `case:${record.id}:approval:${input.gate}:${record.attemptsUsed}`;

    const existing = await this.prisma.action.findUnique({
      where: { idempotencyKey },
      include: { approval: true },
    });

    if (existing?.approval) {
      this.logger.log(
        `${toCaseRef(record.id)} already has an approval for ${input.gate} at attempt ${record.attemptsUsed}`,
      );
      return { ...existing.approval, case: record };
    }

    const merchant = await this.prisma.merchant.findUniqueOrThrow({
      where: { id: record.merchantId },
    });
    const { pack } = await this.policy.getActive(record.merchantId);

    const ask: Ask = buildAsk(
      {
        caseId: record.id,
        type: record.type,
        rootCause: record.rootCause,
        amountPaise: record.amountPaise,
        attemptsUsed: record.attemptsUsed,
        attemptCap: record.attemptCap,
        confidence: record.diagnosisConfidence,
        segment: record.customer.segment,
        customerName: record.customer.name,
        merchantName: merchant.displayName,
        hinglish: record.customer.languagePref.startsWith("hi"),
        contact: maskedContact(record.customer),
        failureCode: record.failureCode,
        originId: record.originId,
        lastSentimentScore: record.lastSentimentScore,
        channel: input.channel,
        handoverReason: input.reason ?? null,
      },
      input.gate,
      pack,
    );

    try {
      const approval = await this.prisma.transaction(async (tx) => {
        const action = await tx.action.create({
          data: {
            caseId: record.id,
            kind: ask.draft.channel,
            channel: ask.draft.channel,
            status: "NEEDS_APPROVAL",
            attempt: record.attemptsUsed + 1,
            idempotencyKey,
            payload: {
              draft: ask.draft,
              concessionPaise: input.concessionPaise ?? ask.concessionPaise,
              discountPercent: input.discountPercent ?? null,
            } as unknown as Prisma.InputJsonValue,
          },
        });

        return tx.approval.create({
          data: {
            caseId: record.id,
            actionId: action.id,
            // Explicit rather than the column default, which is the database's
            // clock. A batch works ten simulated days in a few minutes, and a
            // request stamped with the wall clock is a request that was raised
            // in the future relative to every decision about it — so nothing
            // ever became old enough to answer (B-28).
            requestedAt: this.clock.now(),
            gate: input.gate,
            headline: ask.headline,
            justification: ask.justification as unknown as Prisma.InputJsonValue,
            chips: ask.chips as unknown as Prisma.InputJsonValue,
            draft: ask.draft as unknown as Prisma.InputJsonValue,
            candidates: ask.candidates as unknown as Prisma.InputJsonValue,
            ifApproved: ask.ifApproved,
            ifRejected: ask.ifRejected,
            resumeSteps: ask.resumeSteps as unknown as Prisma.InputJsonValue,
            concessionPaise: ask.concessionPaise,
            atRiskPaise: record.amountPaise,
          },
        });
      });

      this.logger.log(
        `${toCaseRef(record.id)} raised ${input.gate} approval ${approval.id} · ${ask.headline}`,
      );

      await this.announceQueueDepth(record.merchantId, {
        name: "approval.pending",
        approvalId: approval.id,
        caseId: toCaseRef(record.id),
        gate: input.gate,
      });

      return { ...approval, case: record };
    } catch (error) {
      // Two workers escalating the same case at the same attempt. The loser
      // reads the winner's row rather than raising a second card.
      if (!isUniqueViolation(error)) throw error;

      const claimed = await this.prisma.action.findUniqueOrThrow({
        where: { idempotencyKey },
        include: { approval: true },
      });

      if (!claimed.approval) throw error;
      return { ...claimed.approval, case: record };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Everything waiting on a human, ordered by money at risk.
   *
   * A queue ordered by arrival is fair to requests; a revenue product should be
   * fair to the revenue — and the wait clock on every card keeps the ageing
   * ones visible anyway.
   */
  async pending(merchantId: string): Promise<ApprovalRequestView[]> {
    const rows = await this.prisma.approval.findMany({
      where: { decision: null, case: narratedCases(merchantId) },
      include: { case: { include: { customer: true } } },
      orderBy: { atRiskPaise: "desc" },
    });

    return rows.map((row) => this.toRequest(row));
  }

  async pendingCount(merchantId: string): Promise<number> {
    return this.prisma.approval.count({
      where: { decision: null, case: narratedCases(merchantId) },
    });
  }

  /** Decisions already taken, newest first — the reading order of a log. */
  async history(merchantId: string): Promise<ApprovalHistoryView[]> {
    const rows = await this.prisma.approval.findMany({
      where: { decision: { not: null }, case: narratedCases(merchantId) },
      include: { case: { include: { customer: true } } },
      orderBy: { decidedAt: "desc" },
    });

    return rows.map((row) => this.toHistoryRow(row));
  }

  async stats(merchantId: string): Promise<ApprovalStats> {
    const [pending, history] = await Promise.all([
      this.pending(merchantId),
      this.history(merchantId),
    ]);

    return computeStats(
      pending.map((row) => ({
        atRiskPaise: row.atRiskPaise,
        requestedMinutesAgo: row.requestedMinutesAgo,
      })),
      history.map((row) => ({
        decision: row.decision,
        latencySeconds: row.latencySeconds,
        atRiskPaise: row.atRiskPaise,
        recoveredPaise: row.recoveredPaise,
        concessionPaise: row.concessionPaise,
      })),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Deciding                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * A yes.
   *
   * The decision is recorded and the send is *queued*, not performed inline.
   * Between a merchant clicking approve and the message going out, the gate has
   * to run again — the customer may have opted out, the quiet window may have
   * closed, the case may have recovered — and running it on the release rather
   * than on the click is what makes an approval a permission rather than a send
   * button (D-67).
   */
  async approve(
    merchantId: string,
    approvalId: string,
    input: { by: string; draftLines?: string[]; draftSubject?: string; restart?: boolean },
  ): Promise<{ approval: DecidedApprovalView; draftEdited: boolean; restarted: boolean }> {
    const row = await this.claimForDecision(merchantId, approvalId);

    /*
     * "Work it again from the start" (D-157).
     *
     * Only on the handover gate, and deliberately: that is the one card whose
     * question is whether the agent carries on, and the only one where "yes,
     * and give it a fresh run" is a coherent answer. Approving a hardship
     * stand-down while resetting the caps would be the product contradicting
     * itself in a single click.
     */
    const restart = Boolean(input.restart) && row.gate === "escalated_to_human";
    if (input.restart && !restart) {
      const message = `A ${row.gate} request cannot restart a case; only a handover can.`;
      throw new BadRequestException({ error: message, message });
    }
    const draft = row.draft as unknown as DraftMessage;

    // The way out is not the approver's to delete. A merchant may rewrite a
    // draft — that is what makes it editable — but if the message they were
    // shown carried the opt-out line, the message that leaves has to carry it
    // too, so it is restored rather than the edit being refused (D-68).
    const showedOptOut = draft.lines.some((line) => line.trim() === OPT_OUT_LINE);
    const submitted = input.draftLines ?? draft.lines;
    const guarded = showedOptOut ? ensureOptOut(submitted) : { lines: submitted, restored: false };

    const edited = guarded.lines.join("\n") !== draft.lines.join("\n");

    const approvedDraft: DraftMessage = edited
      ? { ...draft, lines: guarded.lines, subject: input.draftSubject ?? draft.subject }
      : draft;

    if (guarded.restored) {
      this.logger.warn(
        `${toCaseRef(row.caseId)} approver's edit dropped the opt-out line; it was restored before sending`,
      );
    }

    const decided = await this.recordDecision(row, {
      decision: "approved",
      by: input.by,
      reason: null,
      draftEdited: edited,
      optOutRestored: guarded.restored,
      draft: approvedDraft,
      // Taking a case is a pause with a name on it, and the gate refuses every
      // outbound action while `pausedAt` is set. Approving the handover ask is
      // the merchant undoing their own hold, so the hold is lifted in the same
      // transaction as the decision — otherwise the release they just
      // authorised would be refused by it, and a "carry on" would halt the
      // case it was meant to resume (D-151).
      liftHold: row.gate === "escalated_to_human",
      restart,
    });

    await this.queue.enqueue(
      {
        kind: "approval.release",
        caseId: row.caseId,
        jobId: `approval:${row.id}:release`,
        reason: `Approved by ${input.by} · ${row.headline}`,
        approvalId: row.id,
      },
      { delayMs: 0 },
    );

    return { approval: decided, draftEdited: edited, restarted: restart };
  }

  /**
   * A no.
   *
   * What happens next is the gate's own answer, not a generic stand-down: a
   * refused discount leaves the case to the standard playbook, while a refusal
   * to work a receivable, to guess a diagnosis, or to make a hardship offer is
   * a refusal to touch the case at all — and continuing after one would be the
   * agent overruling the person it just asked.
   */
  async reject(
    merchantId: string,
    approvalId: string,
    input: { by: string; reason: string },
  ): Promise<DecidedApprovalView> {
    const reason = input.reason.trim();
    if (!reason) {
      const message = "A rejection needs a reason.";
      throw new BadRequestException({ error: message, message });
    }

    const row = await this.claimForDecision(merchantId, approvalId);

    const decided = await this.recordDecision(row, {
      decision: "rejected",
      by: input.by,
      reason,
      draftEdited: false,
      draft: row.draft as unknown as DraftMessage,
    });

    if (REJECTION_RESUMES[row.gate]) {
      await this.prisma.action.updateMany({
        where: { id: row.actionId ?? "" },
        data: { status: "BLOCKED", failureReason: `Rejected by ${input.by}: ${reason}` },
      });

      await this.queue.enqueue(
        {
          kind: "case.step",
          caseId: row.caseId,
          jobId: `case:${row.caseId}:step:${row.case.attemptsUsed}`,
          reason: "Concession refused — carrying on with the standard playbook",
          expectAttempt: row.case.attemptsUsed,
        },
        { delayMs: 0 },
      );

      return decided;
    }

    await this.standDown(row, input.by, reason);
    return decided;
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /** Loads a request that is genuinely this merchant's and genuinely open. */
  private async claimForDecision(
    merchantId: string,
    approvalId: string,
  ): Promise<ApprovalWithCase> {
    const row = await this.prisma.approval.findFirst({
      where: { id: approvalId, case: { merchantId } },
      include: { case: { include: { customer: true } } },
    });

    if (!row) {
      // `message` travels alongside `error` so the thrown Error reads as well as
      // the HTTP body does; without it Nest falls back to the class name (B-8).
      const message = `Approval ${approvalId} not found.`;
      throw new NotFoundException({ error: message, message });
    }

    if (row.decision) {
      const message = `Approval ${approvalId} was already ${row.decision} by ${row.decidedBy ?? "a human"}.`;
      throw new BadRequestException({ error: message, message });
    }

    return row;
  }

  /**
   * The decision row and the timeline entry, in one transaction.
   *
   * The Approvals page's History tab and the case's own timeline are the same
   * rows read from two directions, which is the only arrangement in which
   * neither can lie about the other. Writing them separately would allow a
   * decision that the case history has never heard of.
   */
  private async recordDecision(
    row: ApprovalWithCase,
    input: {
      decision: "approved" | "rejected";
      by: string;
      reason: string | null;
      draftEdited: boolean;
      optOutRestored?: boolean;
      draft: DraftMessage;
      /** Clear `pausedAt` with the decision — see the caller. */
      liftHold?: boolean;
      /** Put the case back to attempt zero with the decision (D-157). */
      restart?: boolean;
    },
  ): Promise<DecidedApprovalView> {
    const decidedAt = this.clock.now();
    const latencySeconds = Math.max(
      1,
      Math.round((decidedAt.getTime() - row.requestedAt.getTime()) / 1000),
    );

    const approved = input.decision === "approved";

    const updated = await withSeqRetry(
      () =>
        this.prisma.transaction(async (tx) => {
          if (input.liftHold || input.restart) {
            await tx.case.update({
              where: { id: row.caseId },
              data: {
                ...(input.liftHold ? { pausedAt: null } : {}),
                // The counters, and the instant every action-derived bound is
                // measured from now on. The customer's own protections — the
                // opt-out, the hardship flag — are untouched on purpose: a
                // merchant may give the agent another run at a case, and may
                // not give it another run at somebody who said stop.
                ...(input.restart
                  ? { attemptsUsed: 0, restartedAt: decidedAt, discountRequestedAt: null }
                  : {}),
              },
            });
          }

          const approval = await tx.approval.update({
            where: { id: row.id },
            data: {
              decision: input.decision,
              decidedBy: input.by,
              reason: input.reason,
              decidedAt,
              latencySeconds,
              draftEdited: input.draftEdited,
              // The body that was actually signed off, not the one first proposed.
              draft: input.draft as unknown as Prisma.InputJsonValue,
            },
          });

          await this.events.append(tx, {
            caseId: row.caseId,
            kind: "APPROVAL_DECIDED",
            occurredAt: decidedAt,
            title: approved ? `Approved by ${input.by}` : `Rejected by ${input.by}`,
            summary: approved
              ? `Released after ${formatLatency(latencySeconds)} — the gate re-runs before anything is sent`
              : `${input.reason} — Boa carried on without it`,
            // Green is recovered money and nothing else (PRD 6.4), so a yes reads
            // as the plainest chalk on the rail rather than borrowing that colour.
            badge: {
              label: approved ? "approved" : "rejected",
              tone: approved ? "neutral" : "halted",
            },
            body: {
              type: "facts",
              rows: [
                { label: "Decision", value: approved ? "APPROVED" : "REJECTED", mono: true },
                { label: "Decided by", value: input.by },
                { label: "Response time", value: formatLatency(latencySeconds), mono: true },
                ...(input.reason ? [{ label: "Reason given", value: input.reason }] : []),
                ...(input.draftEdited
                  ? [
                      {
                        label: "Draft",
                        value: input.optOutRestored
                          ? "Edited by the approver · the opt-out line was restored before sending"
                          : "Edited by the approver before sending",
                      },
                    ]
                  : []),
                ...(input.restart
                  ? [
                      {
                        label: "Case restarted",
                        value: `Attempts back to 0 of ${row.case.attemptCap} · channel caps, cool-down and re-presentation count measured from now · the opt-out and hardship blocks are untouched`,
                      },
                    ]
                  : []),
                {
                  label: "Effect",
                  value: approved
                    ? APPROVAL_CLOSES[row.gate]
                      ? "The message is sent once and the case closes as handled"
                      : input.restart
                        ? `The hold is lifted, the case starts again at attempt 1 of ${row.case.attemptCap}, and the gate runs against the reset bounds`
                        : input.liftHold
                        ? `The hold is lifted, the gate re-runs, and Boa continues at attempt ${row.case.attemptsUsed + 1} of ${row.case.attemptCap}`
                        : `The gate re-runs against the approved action and the case continues at attempt ${row.case.attemptsUsed + 1} of ${row.case.attemptCap}`
                    : REJECTION_RESUMES[row.gate]
                      ? "No concession was made · the case continues on the standard playbook"
                      : "Boa stands down · the case is closed to the agent",
                },
                { label: "Request", value: row.id, mono: true },
                { label: "Audited as", value: "HUMAN · APPROVAL_DECIDED", mono: true },
              ],
            } as unknown as Prisma.InputJsonValue,
          });

          return approval;
        }),
      {
        onRetry: (attempt) =>
          this.logger.warn(
            `Event sequence collision on the decision; retrying (attempt ${attempt})`,
          ),
      },
    );

    this.logger.log(
      `${toCaseRef(row.caseId)} approval ${row.id} ${input.decision} by ${input.by} in ${latencySeconds}s`,
    );

    await this.announceQueueDepth(row.case.merchantId, {
      name: "approval.decided",
      approvalId: row.id,
      caseId: toCaseRef(row.caseId),
      decision: approved ? "APPROVED" : "REJECTED",
    });

    return this.toDecided({ ...updated, case: row.case });
  }

  /**
   * Tells the sidebar badge what the queue is now, rather than what changed.
   *
   * A badge that increments and decrements on events drifts the first time one
   * is missed — a socket that reconnected mid-decision leaves a merchant
   * looking at a "3" over an empty queue forever. So the count is queried and
   * sent whole: the browser is told the answer, not an instruction for
   * arriving at it. One extra count query per decision is a cheap price for a
   * number that cannot go wrong (D-106).
   *
   * Published after the transaction rather than inside it, because this is the
   * one figure that must be read *after* the write lands.
   */
  private async announceQueueDepth(
    merchantId: string,
    event:
      | { name: "approval.pending"; approvalId: string; caseId: string; gate: ApprovalGate }
      | {
          name: "approval.decided";
          approvalId: string;
          caseId: string;
          decision: "APPROVED" | "REJECTED";
        },
  ): Promise<void> {
    // A batch answers its own escalations through the simulated merchant, and
    // none of them are in the queue a human sees (D-120); telling every open
    // browser the queue moved would refresh every page for the length of a
    // run. Same rule as the feed (D-101).
    if (this.clock.shifted) return;

    const pending = await this.prisma.approval.count({
      where: { case: narratedCases(merchantId), decision: null },
    });

    this.domain.publish(
      event.name === "approval.pending"
        ? { ...event, merchantId, pending }
        : { ...event, merchantId, pending },
    );
  }

  /** A refusal that ends the case: no further contact, and the reason on the record. */
  private async standDown(row: ApprovalWithCase, by: string, reason: string): Promise<void> {
    if (row.actionId) {
      await this.prisma.action.updateMany({
        where: { id: row.actionId },
        data: { status: "BLOCKED", failureReason: `Rejected by ${by}: ${reason}` },
      });
    }

    // Scheduled work outlives a decision unless it is cancelled. A case closed
    // by a human that still fires a queued nudge is the same failure as a halt
    // that only refuses at the gate (D-62) — correct on paper, visible to the
    // customer.
    for (let attempt = 0; attempt <= row.case.attemptCap + 1; attempt += 1) {
      await this.queue.cancel(`case:${row.caseId}:step:${attempt}`);
    }

    const fresh = await this.prisma.case.findUnique({ where: { id: row.caseId } });
    if (!fresh || fresh.stage === "recovered") return;
    if (fresh.stage === "halted" || fresh.stage === "exhausted") return;

    await this.cases.transition(row.caseId, "halted", {
      kind: "HALTED",
      title: "Contact halted",
      summary: `${by} declined the escalation · ${reason}`,
      badge: { label: "HALTED", tone: "halted" },
      body: {
        type: "facts",
        rows: [
          { label: "Outcome", value: "HALTED", mono: true, tone: "halted" },
          { label: "Declined by", value: by },
          { label: "Reason", value: reason },
          { label: "Gate", value: row.gate, mono: true },
          {
            label: "Further contact",
            value: "None — the agent was refused permission, not merely deferred",
          },
        ],
      } as unknown as Prisma.InputJsonValue,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Row → contract shape                                              */
  /* ---------------------------------------------------------------- */

  private toRequest(row: ApprovalWithCase): ApprovalRequestView {
    return {
      // The request carries its case's number: an approver reading a toast
      // should not have to translate an id before they know which case moved.
      id: row.id,
      caseId: toCaseRef(row.caseId),
      gate: row.gate,
      customer: row.case.customer.name,
      segment: row.case.customer.segment,
      caseType: row.case.type,
      rootCause: row.case.rootCause ?? "UNKNOWN",
      confidence: row.case.diagnosisConfidence,
      atRiskPaise: row.atRiskPaise,
      concessionPaise: row.concessionPaise,
      headline: row.headline,
      justification: row.justification as unknown as string[],
      chips: row.chips as unknown as PolicyChip[],
      draft: row.draft as unknown as DraftMessage,
      candidates: (row.candidates ?? []) as unknown as Candidate[],
      attempts: row.case.attemptsUsed,
      attemptCap: row.case.attemptCap,
      contact: maskedContact(row.case.customer),
      requestedMinutesAgo: minutesSince(row.requestedAt),
      ifApproved: row.ifApproved,
      ifRejected: row.ifRejected,
      resumeSteps: (row.resumeSteps ?? []) as unknown as ResumeStep[],
      rejectionReasons: rejectionReasonsFor(row.gate),
    };
  }

  private toDecided(row: ApprovalWithCase): DecidedApprovalView {
    return {
      id: row.id,
      caseId: toCaseRef(row.caseId),
      gate: row.gate,
      decision: row.decision === "approved" ? "approved" : "rejected",
      decidedBy: row.decidedBy ?? "—",
      // The attempt the case was on when the gate stopped it.
      afterAttempt: Math.max(0, row.case.attemptsUsed),
      headline: row.headline,
      reason: row.reason,
      requestedMinutesAgo: minutesSince(row.requestedAt),
      decidedMinutesAgo: row.decidedAt ? minutesSince(row.decidedAt) : 0,
      latencySeconds: row.latencySeconds ?? 0,
    };
  }

  private toHistoryRow(row: ApprovalWithCase): ApprovalHistoryView {
    const decided = this.toDecided(row);
    const record = row.case;

    const outcome =
      record.stage === "recovered"
        ? `Recovered ₹${inr(record.recoveredAmountPaise)} · ${record.attemptsUsed}/${record.attemptCap}`
        : decided.decision === "rejected"
          ? "Not recovered · the agent stood down"
          : "Not recovered · the action did not land";

    return {
      ...decided,
      customer: record.customer.name,
      caseType: record.type,
      stage: record.stage,
      atRiskPaise: row.atRiskPaise,
      recoveredPaise: record.recoveredAmountPaise,
      // A concession only costs the merchant if it was actually granted.
      concessionPaise: decided.decision === "approved" ? row.concessionPaise : 0,
      outcome,
    };
  }
}

function minutesSince(at: Date): number {
  return Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000));
}

/** "22s" / "3m 06s" — the way both the card and the history row say a duration. */
export function formatLatency(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export { APPROVAL_CLOSES, REJECTION_RESUMES };
