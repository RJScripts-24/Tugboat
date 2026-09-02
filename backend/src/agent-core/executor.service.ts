import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Action, ApprovalGate, Case, Customer, Prisma } from "@prisma/client";

import { APPROVAL_CLOSES, ApprovalsService } from "../approvals/approvals.service";
import type { DraftMessage } from "../approvals/ask-builder";
import {
  CHANNEL_ADAPTERS,
  SIMULATED_CHANNEL_ADAPTERS,
  channelModeLabel,
  type ChannelAdapter,
  type ChannelSendResult,
  type MessageDetail,
  type RetryDetail,
  type VoiceCounterpart,
  type Turn,
  type VoiceDetail,
  type VoiceIntent,
} from "../channels/channel-adapter.interface";
import { voiceCostPaise } from "../channels/channel-costs";
import type { LiveDialogueContext } from "../conversation/voice-dialogue.service";
import { isUniqueViolation } from "../cases/case-events.service";
import { CasesService } from "../cases/cases.service";
import { toCaseRef } from "../common/case-ref";
import { ClockService } from "../common/clock.service";
import { PolicyGateService } from "../policy/policy-gate.service";
import type { PolicyChannel } from "../policy/policy-pack";
import { PolicyService } from "../policy/policy.service";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE, type ActionQueue } from "../queue/action-queue.interface";
import { adapterFor } from "./adapter-selection";
import { nextWrittenRung } from "./playbooks";
import { NoPlanAvailableError, PlannerService, type PlanProposal } from "./planner.service";
import { unreachableChannels } from "./reachability";

/**
 * Plan, gate, send, record — the loop that actually moves money.
 *
 * Two invariants hold on every path through this file. Nothing reaches an
 * adapter without a `GatePass`, which the type system enforces (D-42). And
 * nothing is sent twice, which the unique index on `Action.idempotencyKey`
 * enforces: the row is claimed *before* the send, so a worker that dies
 * mid-flight leaves a claim behind rather than a silent gap.
 */

/** How long a claimed-but-unfinished action is assumed to still be running (D-38). */
const STALE_ACTION_MS = 5 * 60_000;

/** How many rungs of the ladder one step may walk past a refusal before giving up. */
const MAX_ALTERNATIVES = 4;

/** A silent retry has no cool-down to respect, but it should not hammer either. */
const RETRY_GAP_MS = 30 * 60_000;

/** How far ahead a voice call may book a promise. */
const PROMISE_HORIZON_MS = 3 * 24 * 60 * 60_000;

/**
 * The soonest a promise check-in may run.
 *
 * A promise for tonight is still a promise for a day that has not finished, so
 * the check must land after it, not at the moment it was made (B-76).
 */
const MIN_PROMISE_FOLLOW_UP_MS = 12 * 60 * 60_000;

/** Twilio message states that mean nobody received it. */
const FAILED_DELIVERY = ["failed", "undelivered"];

const TITLE_FOR_CHANNEL: Record<string, string> = {
  WHATSAPP: "WhatsApp nudge",
  EMAIL: "Email",
};
/** A second call to the same phone waits this long behind one in progress (B-71). */
const CALL_SPACING_MS = 90_000;
/** A call older than this with no status callback is not in progress; the line dropped and Twilio never said. */
const CALL_IN_PROGRESS_MS = 3 * 60_000;

const EVENT_KIND = {
  RETRY: "RETRY_EXECUTED",
  WHATSAPP: "WHATSAPP_SENT",
  EMAIL: "EMAIL_SENT",
  VOICE: "VOICE_CALL",
} as const;

const TERMINAL_STAGES = ["recovered", "halted", "exhausted"];

export type StepOutcome =
  | { kind: "sent"; channel: PolicyChannel; channelRef: string; stage: string }
  | { kind: "deferred"; until: Date; reason: string }
  | { kind: "escalated"; reason: string }
  | { kind: "closed"; stage: "halted" | "exhausted"; reason: string }
  | { kind: "skipped"; reason: string };

const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100));

type GatePassOf = NonNullable<Awaited<ReturnType<PolicyGateService["check"]>>["pass"]>;

/**
 * Per-step overrides. Today only the simulator sets these: Stage 8 drives the
 * counterpart from the persona it generated, so a batch run is reproducible
 * rather than depending on a hash of the case id.
 */
export type StepOptions = {
  counterpart?: VoiceCounterpart;
  /**
   * Whether a silent retry captures. Only the simulator answers this, because
   * only it knows the true cause and the customer's actual balance.
   */
  captured?: boolean;
  /**
   * Refuse to run if the case has already moved past this attempt. Set from the
   * queued job, so a redelivery is a no-op rather than an extra contact.
   */
  expectAttempt?: number;
  /** A rung a human asked for (D-145). */
  channel?: PolicyChannel;
};

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cases: CasesService,
    private readonly planner: PlannerService,
    private readonly gate: PolicyGateService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalsService,
    private readonly clock: ClockService,
    @Inject(CHANNEL_ADAPTERS) private readonly adapters: Map<string, ChannelAdapter>,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
    @Optional()
    @Inject(SIMULATED_CHANNEL_ADAPTERS)
    private readonly simulatedAdapters: Map<string, ChannelAdapter> | null = null,
  ) {}

  private adapterFor(record: Case, channel: string): ChannelAdapter | undefined {
    return adapterFor(
      { configured: this.adapters, simulated: this.simulatedAdapters },
      record.simRunId,
      channel,
    );
  }

  /** Queues the next step on a case. The only way work is started. */
  async schedule(caseId: number, delayMs: number, reason: string): Promise<void> {
    const attempts = await this.attemptsUsed(caseId);

    await this.queue.enqueue(
      {
        kind: "case.step",
        caseId,
        // Bucketed by attempt so two schedulers racing on the same case produce
        // one job, while a genuinely later step still gets its own.
        jobId: `case:${caseId}:step:${attempts}`,
        reason,
        expectAttempt: attempts,
      },
      { delayMs },
    );
  }

  /**
   * The opening move, queued the moment a case is diagnosed.
   *
   * An abandoned checkout waits three quarters of an hour before anything
   * happens, because a good share of people come back on their own and a nudge
   * at minute two reaches somebody still typing their card number.
   */
  async scheduleFirstStep(caseId: number): Promise<void> {
    const record = await this.prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    const plan = this.planner.propose(record);

    await this.schedule(
      caseId,
      plan.delayMs,
      plan.delayMs > 0
        ? "Opening wait — the customer may still finish on their own"
        : "First step on a newly diagnosed case",
    );
  }

  /**
   * One step: propose, check, act.
   *
   * A refusal that leaves the case alive (a spent channel, a disabled one)
   * walks down the ladder and tries the next rung, which is what makes the
   * playbook a preference order rather than a fixed script.
   */
  async step(caseId: number, options: StepOptions = {}): Promise<StepOutcome> {
    const record = await this.prisma.case.findUnique({
      where: { id: caseId },
      include: { customer: true },
    });

    if (!record) return { kind: "skipped", reason: `Case ${caseId} no longer exists` };
    if (TERMINAL_STAGES.includes(record.stage)) {
      return { kind: "skipped", reason: `Case is already ${record.stage}` };
    }

    // The job was scheduled for a particular rung of the ladder. If the case has
    // since climbed past it, this is a redelivery of work already done.
    if (options.expectAttempt !== undefined && record.attemptsUsed !== options.expectAttempt) {
      return {
        kind: "skipped",
        reason: `Job was scheduled at attempt ${options.expectAttempt}; the case is at ${record.attemptsUsed}`,
      };
    }

    const merchant = await this.prisma.merchant.findUniqueOrThrow({
      where: { id: record.merchantId },
    });

    // A channel the customer has no contact for is refused before the ladder
    // is read, so a missing phone walks the case to email instead of to a
    // failed send and an escalation (B-61).
    const unreachable = unreachableChannels(record.customer);
    const refused: PolicyChannel[] = [...unreachable];

    for (let attempt = 0; attempt < MAX_ALTERNATIVES; attempt += 1) {
      let plan: PlanProposal;
      try {
        plan = this.planner.propose(record, { exclude: refused, unreachable, channel: options.channel });
      } catch (error) {
        if (!(error instanceof NoPlanAvailableError)) throw error;
        return this.close(record, "exhausted", "Every channel in the playbook was refused");
      }

      await this.recordPlan(record, plan);

      const verdict = await this.gate.check(caseId, {
        channel: plan.channel,
        concessionPaise: plan.concessionPaise,
        discountPercent: plan.discountPercent,
      });

      if (verdict.outcome.kind === "allow") {
        // One phone, one call at a time. Two rungs released in the same second
        // — a deferred rung and a human's request, say — dialled one handset
        // twice at once and both rang out as no-answer (B-71). The second waits
        // ninety seconds behind the first rather than colliding with it.
        if (plan.channel === "VOICE" && (await this.callInProgressTo(record.customer))) {
          const jobId = `case:${caseId}:step:${record.attemptsUsed}`;
          await this.queue.cancel(jobId);
          await this.queue.enqueue(
            {
              kind: "case.step",
              caseId,
              jobId,
              reason: "Another call to this phone is in progress",
              expectAttempt: record.attemptsUsed,
              channel: options.channel,
            },
            { delayMs: CALL_SPACING_MS },
          );
          const until = new Date(this.clock.nowMs() + CALL_SPACING_MS);
          return { kind: "deferred", until, reason: "Another call to this phone is in progress" };
        }

        return this.execute(
          record,
          record.customer,
          merchant.displayName,
          plan,
          verdict.pass!,
          options,
        );
      }

      if (verdict.outcome.kind === "defer") {
        const { until, reason } = verdict.outcome;
        await this.cases.moveStage(caseId, "waiting", reason);

        // One job per rung. The follow-up scheduled after the previous send
        // already holds this id at a guessed time; the gate has now told us the
        // real one, so the guess is replaced rather than raced against.
        const jobId = `case:${caseId}:step:${record.attemptsUsed}`;
        await this.queue.cancel(jobId);
        await this.queue.enqueue(
          {
            kind: "case.step",
            caseId,
            jobId,
            reason,
            expectAttempt: record.attemptsUsed,
            // A rung a human asked for survives the deferral (D-145).
            channel: options.channel,
          },
          { delayMs: Math.max(0, until.getTime() - this.clock.nowMs()) },
        );
        return { kind: "deferred", until, reason };
      }

      if (verdict.outcome.kind === "approve") {
        return this.escalate(record, verdict.outcome.reason, verdict.outcome.gate, plan.channel, {
          concessionPaise: plan.concessionPaise,
          discountPercent: plan.discountPercent,
        });
      }

      if (verdict.outcome.kind === "halt") {
        return this.close(record, "halted", verdict.outcome.reason);
      }

      if (verdict.outcome.kind === "exhaust") {
        return this.close(record, "exhausted", verdict.outcome.reason);
      }

      // Refused: the case survives, only this rung of the ladder is closed.
      refused.push(plan.channel);
      this.logger.log(`${toCaseRef(caseId)} ${plan.channel} refused — trying the next rung`);
    }

    return this.close(record, "exhausted", "No channel in the playbook was allowed");
  }

  /* ---------------------------------------------------------------- */
  /* Sending                                                           */
  /* ---------------------------------------------------------------- */

  private async execute(
    record: Case,
    customer: Customer,
    merchantName: string,
    plan: PlanProposal,
    pass: GatePassOf,
    options: StepOptions,
  ): Promise<StepOutcome> {
    const adapter = this.adapterFor(record, plan.channel);
    if (!adapter) throw new Error(`No adapter registered for channel ${plan.channel}`);

    const claim = await this.claim(record.id, plan);
    if (!claim.proceed) return { kind: "skipped", reason: claim.reason };

    const copy = this.planner.copyContext(record, customer, merchantName, plan.attempt);
    const promiseDate = new Date(this.clock.nowMs() + PROMISE_HORIZON_MS);

    let result: ChannelSendResult;
    try {
      result = await adapter.send(pass, {
        caseId: record.id,
        attempt: plan.attempt,
        to: contactFor(plan.channel, customer),
        copy,
        counterpart: options.counterpart,
        captured: options.captured,
        promiseDateLabel: dayLabel(promiseDate),
      });
    } catch (error) {
      return this.failAction(record, claim.action, plan, (error as Error).message);
    }

    await this.prisma.action.update({
      where: { id: claim.action.id },
      data: {
        status: "EXECUTED",
        executedAt: this.clock.now(),
        channelRef: result.channelRef,
        costPaise: result.costPaise,
        payload: result.detail as unknown as Prisma.InputJsonValue,
      },
    });

    return this.recordSend(record, customer, plan, result, promiseDate);
  }

  /**
   * Claim-then-work, with a lease.
   *
   * The row goes in before the send, so a crash after the send cannot be
   * mistaken for a send that never happened. A null completion column cannot
   * tell a dead worker from a live one (B-10), so the age of the claim is what
   * resolves it.
   */
  private async claim(
    caseId: number,
    plan: PlanProposal,
  ): Promise<{ proceed: true; action: Action } | { proceed: false; reason: string }> {
    const idempotencyKey = `case:${caseId}:${plan.channel}:${plan.attempt}`;

    try {
      const action = await this.prisma.action.create({
        data: {
          caseId,
          kind: plan.channel,
          channel: plan.channel,
          status: "PLANNED",
          attempt: plan.attempt,
          idempotencyKey,
          payload: { chosen: plan.chosen, because: plan.because } as Prisma.InputJsonValue,
        },
      });
      return { proceed: true, action };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.action.findUniqueOrThrow({ where: { idempotencyKey } });

    if (existing.status === "EXECUTED") {
      return { proceed: false, reason: `${idempotencyKey} was already sent` };
    }

    const age = Date.now() - existing.createdAt.getTime();
    if (age < STALE_ACTION_MS) {
      return { proceed: false, reason: `${idempotencyKey} is already being sent` };
    }

    this.logger.warn(`Taking over stale action ${idempotencyKey} (${Math.round(age / 1000)}s old)`);
    return { proceed: true, action: existing };
  }

  private async failAction(
    record: Case,
    action: Action,
    plan: PlanProposal,
    message: string,
  ): Promise<StepOutcome> {
    await this.prisma.action.update({
      where: { id: action.id },
      data: { status: "FAILED", failureReason: message },
    });

    this.logger.error(`${toCaseRef(record.id)} ${plan.channel} failed: ${message}`);

    // A channel that could not run is not a customer who did not answer. The
    // case goes to a human rather than continuing as though the step happened.
    return this.escalate(record, `${plan.channel} could not be delivered: ${message}`, null);
  }

  /* ---------------------------------------------------------------- */
  /* Recording what happened                                           */
  /* ---------------------------------------------------------------- */

  private async recordPlan(record: Case, plan: PlanProposal): Promise<void> {
    const event = {
      kind: "PLANNED" as const,
      title: `Planned — ${plan.channel.toLowerCase()}`,
      summary: plan.chosen,
      badge: { label: `attempt ${plan.attempt}/${record.attemptCap}`, tone: "neutral" },
      body: {
        type: "plan",
        chosen: plan.chosen,
        because: plan.because,
        rejected: plan.rejected,
      } as unknown as Prisma.InputJsonValue,
    };

    if (record.stage === "intervening") {
      await this.cases.appendEvent(record.id, event);
      return;
    }

    await this.cases.transition(record.id, "intervening", event);
  }

  private async recordSend(
    record: Case,
    customer: Customer,
    plan: PlanProposal,
    result: ChannelSendResult,
    promiseDate: Date,
  ): Promise<StepOutcome> {
    const spend = { attemptsUsed: { increment: 1 }, costPaise: { increment: result.costPaise } };
    const detail = result.detail;

    if (detail.kind === "retry" && detail.captured) {
      await this.cases.transition(
        record.id,
        "recovered",
        retryEvent(record, plan, result, detail),
        {
          ...spend,
          recoveredAmountPaise: record.amountPaise,
        },
      );
      await this.cases.appendEvent(record.id, recoveredEvent(record, result.channelRef));
      this.logger.log(`${toCaseRef(record.id)} RECOVERED ${inr(record.amountPaise)} rupees`);
      return {
        kind: "sent",
        channel: plan.channel,
        channelRef: result.channelRef,
        stage: "recovered",
      };
    }

    // A real call has only been placed. The conversation and its outcome
    // arrive over the voice webhooks; until then the case waits, with the
    // ordinary follow-up in the queue in case the line never connects (D-144).
    if (detail.kind === "voice" && detail.pending) {
      await this.cases.settle(record.id, "waiting", voiceEvent(customer, result, detail), spend);
      await this.scheduleFollowUp(record, plan.channel);
      return { kind: "sent", channel: plan.channel, channelRef: result.channelRef, stage: "waiting" };
    }

    if (detail.kind === "voice" && detail.intent === "PROMISED_TO_PAY") {
      await this.cases.transition(
        record.id,
        "promised",
        voiceEvent(customer, result, detail),
        spend,
      );
      await this.recordPromise(record, promiseDate, result.mode === "real" ? "real" : "simulated");
      return {
        kind: "sent",
        channel: plan.channel,
        channelRef: result.channelRef,
        stage: "promised",
      };
    }

    if (detail.kind === "voice" && detail.intent === "HARDSHIP_DECLARED") {
      await this.cases.transition(record.id, "escalated", voiceEvent(customer, result, detail), {
        ...spend,
        hardshipFlaggedAt: this.clock.now(),
      });
      await this.cases.appendEvent(
        record.id,
        escalatedEvent("Hardship language on the call — the agent stood down", "hardship_language"),
      );
      await this.approvals.raise({
        caseId: record.id,
        gate: "hardship_language",
        channel: plan.channel,
      });
      return { kind: "escalated", reason: "Hardship declared on the call" };
    }

    const event =
      detail.kind === "retry"
        ? retryEvent(record, plan, result, detail)
        : detail.kind === "voice"
          ? voiceEvent(customer, result, detail)
          : messageEvent(record, customer, plan, result, detail);

    await this.cases.settle(record.id, "waiting", event, spend);
    await this.scheduleFollowUp(record, plan.channel);

    return { kind: "sent", channel: plan.channel, channelRef: result.channelRef, stage: "waiting" };
  }

  /**
   * A real call has ended (D-144). Twilio reported the line dropping; the
   * transcript and the engine's reading of it are in `voice_calls`. This is
   * the bookkeeping `recordSend` does for a simulated call, done a few
   * minutes later from a webhook: the action row gets the real transcript and
   * cost, the timeline gets the call, and a promise or a hardship moves the
   * case exactly as it would have.
   */
  async completeVoiceCall(
    callId: string,
    outcome: { answered: boolean; seconds: number; audioUrl: string | null; providerStatus: string },
  ): Promise<void> {
    const call = await this.prisma.voiceCall.findUnique({ where: { id: callId } });
    if (!call || call.status === "completed") return;

    const record = await this.prisma.case.findUnique({
      where: { id: call.caseId },
      include: { customer: true },
    });
    if (!record) return;

    const transcript = Array.isArray(call.transcript) ? (call.transcript as unknown as Turn[]) : [];
    const context = call.context as unknown as LiveDialogueContext;
    const heard = transcript.some((turn) => turn.speaker === "CUSTOMER" && !/^\(/.test(turn.text));
    const intent: VoiceIntent =
      !outcome.answered || !heard
        ? "NO_ANSWER"
        : call.intent === "PROMISED_TO_PAY" || call.intent === "HARDSHIP_DECLARED"
          ? call.intent
          : "NO_COMMITMENT";
    const costPaise = voiceCostPaise(outcome.seconds);

    const detail: VoiceDetail = {
      kind: "voice",
      seconds: outcome.seconds,
      transcript,
      summary: liveCallSummary(intent, context, outcome.providerStatus),
      intent,
      language: context.hinglish ? "hi-IN" : "en-IN",
      turnsFromModel: transcript.filter((turn) => turn.speaker === "BOA").length,
      audioUrl: outcome.audioUrl,
      recording: outcome.audioUrl ? "Twilio call recording · both sides of the line" : null,
    };

    await this.prisma.action.updateMany({
      where: { channelRef: callId },
      data: { payload: detail as unknown as Prisma.InputJsonValue, costPaise },
    });
    await this.prisma.voiceCall.update({
      where: { id: callId },
      data: { status: "completed", intent, seconds: outcome.seconds },
    });

    const result: ChannelSendResult = { channelRef: callId, mode: "real", costPaise, detail };
    const spend = { costPaise: { increment: costPaise } };
    const event = voiceEvent(record.customer, result, detail);
    const stepJob = `case:${record.id}:step:${record.attemptsUsed}`;

    try {
      if (intent === "PROMISED_TO_PAY") {
        await this.cases.transition(record.id, "promised", event, spend);
        await this.queue.cancel(stepJob);
        // The day the customer named on the call, not the one Boa offered.
        // This used to be the horizon constant unconditionally, so "aaj raat
        // ko" was filed as three days out and the card showed a date nobody
        // had agreed to (B-76).
        await this.recordPromise(
          record,
          call.promisedFor ?? new Date(this.clock.nowMs() + PROMISE_HORIZON_MS),
          "real",
        );
        await this.sendPromisedLink(record);
        this.logger.log(`${toCaseRef(record.id)} promised on the call ${callId}`);
        return;
      }

      if (intent === "HARDSHIP_DECLARED") {
        await this.cases.transition(record.id, "escalated", event, {
          ...spend,
          hardshipFlaggedAt: this.clock.now(),
        });
        await this.queue.cancel(stepJob);
        await this.cases.appendEvent(
          record.id,
          escalatedEvent("Hardship language on the call — the agent stood down", "hardship_language"),
        );
        await this.approvals.raise({ caseId: record.id, gate: "hardship_language", channel: "VOICE" });
        this.logger.log(`${toCaseRef(record.id)} escalated from the call ${callId}`);
        return;
      }
    } catch (error) {
      // The case moved on while the call was in progress (paid, halted, taken
      // over). The call is still recorded; nothing is rewritten.
      this.logger.warn(
        `${toCaseRef(record.id)} could not move on the call's outcome: ${(error as Error).message}`,
      );
    }

    await this.cases.appendEvent(record.id, event);
    await this.prisma.case.update({ where: { id: record.id }, data: spend });
    this.logger.log(`${toCaseRef(record.id)} call ${callId} ended · ${intent}`);
  }

  private async callInProgressTo(customer: Customer): Promise<boolean> {
    if (!customer.phone) return false;
    const open = await this.prisma.voiceCall.findFirst({
      where: {
        status: { in: ["dialing", "talking", "wrapping"] },
        updatedAt: { gte: new Date(this.clock.nowMs() - CALL_IN_PROGRESS_MS) },
        case: { customer: { phone: customer.phone } },
      },
      select: { id: true },
    });
    return open !== null;
  }

  private async recordPromise(
    record: Case,
    promiseDate: Date,
    telephony: "real" | "simulated" = "simulated",
  ): Promise<void> {
    const promise = await this.prisma.paymentPromise.create({
      data: {
        caseId: record.id,
        promisedAmountPaise: record.amountPaise,
        promisedDate: promiseDate,
      },
    });

    const jobId = `promise:${promise.id}`;
    await this.prisma.paymentPromise.update({
      where: { id: promise.id },
      data: { followUpJobId: jobId },
    });

    await this.cases.appendEvent(record.id, {
      kind: "PROMISE_RECORDED",
      title: `Promise recorded — ${inr(record.amountPaise)} rupees`,
      summary: `Customer committed to ${dayLabel(promiseDate)} · follow-up scheduled that morning`,
      badge: { label: "promised", tone: "waiting" },
      body: {
        type: "promise",
        amountPaise: record.amountPaise,
        dateLabel: dayLabel(promiseDate),
        daysAway: Math.max(
          1,
          Math.round((promiseDate.getTime() - this.clock.nowMs()) / 86_400_000),
        ),
        rows: [
          { label: "Amount", value: `${inr(record.amountPaise)} rupees`, mono: true },
          { label: "Promised for", value: dayLabel(promiseDate), mono: true },
          {
            label: "Heard on",
            value: telephony === "real" ? "Voice call · real call" : "Voice call · simulated telephony",
          },
          {
            label: "Follow-up",
            value: "Scheduled — a broken promise escalates rather than re-nudges",
          },
        ],
      } as unknown as Prisma.InputJsonValue,
    });

    await this.queue.enqueue(
      {
        kind: "promise.checkin",
        caseId: record.id,
        jobId,
        reason: `Promised ${inr(record.amountPaise)} rupees for ${dayLabel(promiseDate)}`,
        promiseId: promise.id,
      },
      // Never zero: a customer who says "aaj raat ko" is promising today, and
      // a follow-up computed as "the promised moment" would fire while they are
      // still on the phone. Give the day they named time to actually happen.
      { delayMs: Math.max(MIN_PROMISE_FOLLOW_UP_MS, promiseDate.getTime() - this.clock.nowMs()) },
    );
  }

  /**
   * Send the payment link Boa said she would send (D-153).
   *
   * On the call she says the link is going to their WhatsApp. Before this she
   * said it and nothing sent one — the agent made a commitment the system did
   * not keep, on a recorded line (B-76). This queues the send the moment the
   * promise is recorded.
   *
   * It is an ordinary gated rung, not a side channel: quiet hours, the opt-out
   * and every cap still answer first, and the timeline shows the verdict. A
   * customer with no phone simply gets nothing here, which is why the spoken
   * line now says she is sending it rather than that it has arrived.
   */
  private async sendPromisedLink(record: Case & { customer: Customer }): Promise<void> {
    if (!record.customer.phone) return;

    await this.queue.enqueue(
      {
        kind: "case.step",
        caseId: record.id,
        jobId: `case:${record.id}:promise-link:${record.attemptsUsed}`,
        reason: "Payment link promised on the call",
        expectAttempt: record.attemptsUsed,
        channel: "WHATSAPP",
      },
      { delayMs: 0 },
    );
  }

/**
   * Twilio has decided what really happened to a message (D-154).
   *
   * The send path records the provider's synchronous answer, which for WhatsApp
   * is "queued" — an acknowledgement that Twilio took the request, not that
   * anybody received anything. Minutes later it may become `delivered`, or
   * `failed` because the sandbox session lapsed. Nothing used to ask, so a case
   * could show a delivered nudge that never arrived and count it against the
   * attempt cap (B-76).
   *
   * Idempotent by construction: only an `EXECUTED` action is claimed, so a
   * redelivered callback finds nothing left to change.
   */
  async reconcileDelivery(
    channelRef: string,
    providerStatus: string,
    errorCode: string | null,
  ): Promise<void> {
    if (!FAILED_DELIVERY.includes(providerStatus)) return;

    const action = await this.prisma.action.findFirst({
      where: { channelRef, status: "EXECUTED" },
      include: { case: true },
    });
    if (!action) return;

    const record = action.case;
    const reason = errorCode ? `${providerStatus} · Twilio ${errorCode}` : providerStatus;

    // An attempt is a contact that reached somebody. This one did not, so the
    // case gets it back — but only the first time a channel fails on it. Two
    // refunds for one dead channel is a loop, and the ladder has to be allowed
    // to give up on a number that does not work.
    const alreadyRefunded = await this.prisma.action.count({
      where: { caseId: record.id, channel: action.channel, status: "FAILED" },
    });
    const refund = alreadyRefunded === 0 && record.attemptsUsed > 0;

    await this.prisma.action.update({
      where: { id: action.id },
      data: {
        status: "FAILED",
        payload: {
          ...(action.payload as Record<string, unknown> | null),
          status: `${reason} · not delivered`,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    if (refund) {
      await this.prisma.case.update({
        where: { id: record.id },
        data: { attemptsUsed: { decrement: 1 } },
      });
      // The follow-up queued at send time carries the attempt count it was
      // scheduled against (D-56); refunding moves the case past it, so that job
      // would be refused as stale and the case would simply stop. Replace it.
      await this.queue.cancel(`case:${record.id}:step:${record.attemptsUsed}`);
      await this.queue.enqueue(
        {
          kind: "case.step",
          caseId: record.id,
          jobId: `case:${record.id}:step:${record.attemptsUsed - 1}:redelivery`,
          expectAttempt: record.attemptsUsed - 1,
          reason: `${action.channel} was not delivered — ${reason}`,
        },
        { delayMs: 0 },
      );
    }

    await this.cases.appendEvent(record.id, {
      kind: "DELIVERY_FAILED",
      title: `${(action.channel ? TITLE_FOR_CHANNEL[action.channel] : null) ?? "Message"} was not delivered`,
      summary: refund
        ? `${reason} · the attempt was given back`
        : `${reason} · the attempt stands, this channel has failed before`,
      badge: { label: "not delivered", tone: "halted" },
      body: {
        type: "facts",
        rows: [
          { label: "Provider verdict", value: reason, mono: true },
          { label: "Message id", value: channelRef, mono: true },
          {
            label: "Attempt",
            value: refund
              ? "Returned to the case — nobody was contacted"
              : "Counted — the channel has already been given a second chance",
          },
        ],
      } as unknown as Prisma.InputJsonValue,
    });

    this.logger.warn(`${toCaseRef(record.id)} ${action.channel} ${channelRef}: ${reason}`);
  }

  /** The promised date has arrived. Kept closes it; broken sends it to a person. */
  async checkPromise(promiseId: string): Promise<StepOutcome> {
    const promise = await this.prisma.paymentPromise.findUnique({
      where: { id: promiseId },
      include: { case: true },
    });

    if (!promise || promise.status !== "PENDING") {
      return { kind: "skipped", reason: `Promise ${promiseId} is already resolved` };
    }

    if (promise.case.stage === "recovered") {
      await this.prisma.paymentPromise.update({
        where: { id: promiseId },
        data: { status: "KEPT", resolvedAt: this.clock.now() },
      });
      return { kind: "skipped", reason: "Promise kept — the case had already recovered" };
    }

    await this.prisma.paymentPromise.update({
      where: { id: promiseId },
      data: { status: "BROKEN", resolvedAt: this.clock.now() },
    });

    // A broken promise is not another nudge. Somebody said a date and it
    // passed; the next move belongs to a person.
    return this.escalate(
      promise.case,
      `Promised ${inr(promise.promisedAmountPaise)} rupees by ${dayLabel(promise.promisedDate)} and the payment did not arrive`,
      null,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Releasing what a human approved                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Sends the message a merchant signed off — after checking it again.
   *
   * The second gate run is the point of this method. An approval is a
   * permission, not a send button: between the click and the release the
   * customer may have replied STOP, the quiet window may have closed, the
   * channel cap may have been spent by another job, or the case may have
   * recovered on its own. Only the escalation gates are cleared by an approval
   * (D-66); every bound that exists to protect a person still applies, so an
   * approved message to somebody who has since opted out halts rather than
   * going out.
   */
  async releaseApproved(approvalId: string): Promise<StepOutcome> {
    const approval = await this.prisma.approval.findUnique({
      where: { id: approvalId },
      include: { case: { include: { customer: true } }, action: true },
    });

    if (!approval) return { kind: "skipped", reason: `Approval ${approvalId} no longer exists` };
    if (approval.decision !== "approved") {
      return {
        kind: "skipped",
        reason: `Approval ${approvalId} is ${approval.decision ?? "still open"}`,
      };
    }

    const record = approval.case;
    if (TERMINAL_STAGES.includes(record.stage)) {
      return { kind: "skipped", reason: `Case is already ${record.stage}` };
    }

    // Read the claim before running the gate, not after. A redelivered release
    // of an action that has already been sent must be a no-op — running the
    // gate first would defer it on the cool-down its own send just started and
    // re-queue a job for work that is finished (B-22).
    if (approval.action && approval.action.status !== "NEEDS_APPROVAL") {
      return {
        kind: "skipped",
        reason: `Approval ${approvalId} has already been released (${approval.action.status})`,
      };
    }

    const draft = approval.draft as unknown as DraftMessage;
    const payload = (approval.action?.payload ?? {}) as { discountPercent?: number | null };

    const verdict = await this.gate.check(record.id, {
      channel: draft.channel,
      concessionPaise: approval.concessionPaise,
      discountPercent: payload.discountPercent ?? undefined,
      approvedBy: {
        gate: approval.gate,
        by: approval.decidedBy ?? "a merchant",
        at: approval.decidedAt ?? this.clock.now(),
      },
    });

    if (verdict.outcome.kind === "defer") {
      const { until, reason } = verdict.outcome;
      await this.cases.moveStage(record.id, "waiting", reason);
      await this.queue.enqueue(
        {
          kind: "approval.release",
          caseId: record.id,
          jobId: `approval:${approval.id}:release`,
          reason,
          approvalId: approval.id,
        },
        { delayMs: Math.max(0, until.getTime() - this.clock.nowMs()) },
      );
      return { kind: "deferred", until, reason };
    }

    if (verdict.outcome.kind === "halt") {
      return this.close(record, "halted", verdict.outcome.reason);
    }

    if (verdict.outcome.kind === "exhaust") {
      return this.close(record, "exhausted", verdict.outcome.reason);
    }

    if (verdict.outcome.kind !== "allow") {
      // A refusal on a released action is not "try the next rung": the human
      // approved this message, not a substitute for it.
      return this.close(
        record,
        "halted",
        `The approved action was refused at execution: ${verdict.outcome.reason}`,
      );
    }

    return this.sendApproved(record, draft, verdict.pass!, approval);
  }

  private async sendApproved(
    record: Case & { customer: Customer },
    draft: DraftMessage,
    pass: GatePassOf,
    approval: {
      id: string;
      gate: ApprovalGate;
      actionId: string | null;
      decidedBy: string | null;
      headline: string;
    },
  ): Promise<StepOutcome> {
    const adapter = this.adapterFor(record, draft.channel);
    if (!adapter) throw new Error(`No adapter registered for channel ${draft.channel}`);

    // Compare-and-set on the row the gate already stopped: the action leaves
    // NEEDS_APPROVAL exactly once, so a redelivered release job loses the race
    // rather than sending a second copy.
    if (approval.actionId) {
      const claimed = await this.prisma.action.updateMany({
        where: { id: approval.actionId, status: "NEEDS_APPROVAL" },
        data: { status: "PLANNED" },
      });

      if (claimed.count !== 1) {
        return { kind: "skipped", reason: `Approval ${approval.id} has already been released` };
      }
    }

    const merchant = await this.prisma.merchant.findUniqueOrThrow({
      where: { id: record.merchantId },
    });

    const attempt = record.attemptsUsed + 1;
    const plan: PlanProposal = {
      channel: draft.channel,
      attempt,
      chosen: approval.headline,
      because: `Approved by ${approval.decidedBy ?? "a merchant"} · gate ${approval.gate}`,
      rejected: [
        {
          option: "Send it without asking",
          reason: `The ${approval.gate} gate refused it; only a human could release this`,
        },
      ],
      delayMs: 0,
      concessionPaise: 0,
      discountPercent: 0,
      source: "playbook",
    };

    let result: ChannelSendResult;
    try {
      result = await adapter.send(pass, {
        caseId: record.id,
        attempt,
        to: contactFor(draft.channel, record.customer),
        copy: this.planner.copyContext(record, record.customer, merchant.displayName, attempt),
        // Verbatim: the approver read this body and may have rewritten it, so
        // re-deriving copy here would send something nobody signed off.
        approved: { lines: draft.lines, subject: draft.subject },
      });
    } catch (error) {
      const message = (error as Error).message;
      if (approval.actionId) {
        await this.prisma.action.update({
          where: { id: approval.actionId },
          data: { status: "FAILED", failureReason: message },
        });
      }
      this.logger.error(`${toCaseRef(record.id)} approved ${draft.channel} failed: ${message}`);
      return this.escalate(
        record,
        `The approved ${draft.channel} could not be delivered: ${message}`,
        null,
      );
    }

    if (approval.actionId) {
      await this.prisma.action.update({
        where: { id: approval.actionId },
        data: {
          status: "EXECUTED",
          executedAt: this.clock.now(),
          channelRef: result.channelRef,
          costPaise: result.costPaise,
          payload: result.detail as unknown as Prisma.InputJsonValue,
        },
      });
    }

    const spend = { attemptsUsed: { increment: 1 }, costPaise: { increment: result.costPaise } };
    const detail = result.detail;

    if (detail.kind === "retry" && detail.captured) {
      await this.cases.transition(
        record.id,
        "recovered",
        retryEvent(record, plan, result, detail),
        {
          ...spend,
          recoveredAmountPaise: record.amountPaise,
        },
      );
      await this.cases.appendEvent(record.id, recoveredEvent(record, result.channelRef));
      return {
        kind: "sent",
        channel: draft.channel,
        channelRef: result.channelRef,
        stage: "recovered",
      };
    }

    const event =
      detail.kind === "retry"
        ? retryEvent(record, plan, result, detail)
        : detail.kind === "voice"
          ? voiceEvent(record.customer, result, detail)
          : messageEvent(record, record.customer, plan, result, detail);

    // A stand-down offer is sent once and followed by nothing. Every other
    // approved action resumes the playbook inside the bounds it already had.
    if (APPROVAL_CLOSES[approval.gate]) {
      await this.prisma.case.update({ where: { id: record.id }, data: spend });
      await this.cases.appendEvent(record.id, event);
      return this.close(
        { ...record, attemptsUsed: attempt },
        "halted",
        `${approval.decidedBy ?? "A merchant"} approved a stand-down offer · sent once, and this case is closed to further contact`,
      );
    }

    await this.cases.settle(record.id, "waiting", event, spend);
    await this.scheduleFollowUp(record, draft.channel);

    return {
      kind: "sent",
      channel: draft.channel,
      channelRef: result.channelRef,
      stage: "waiting",
    };
  }

  /* ---------------------------------------------------------------- */
  /* Endings                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * The case stops and a person is asked.
   *
   * A gate name means the PolicyGate refused on one of the four escalation
   * gates, and the approvals queue gets a card carrying the exact message that
   * was stopped. Without one, the escalation is operational — an adapter that
   * threw, a promise that passed its date — and D-69 left those cases with no
   * card at all, on the reasoning that there was no question to ask.
   *
   * There was: *carry on, or stand down*. A case escalated with no gate sat in
   * `escalated` forever, the agent stopped and nobody asked to restart it, and
   * the queue a merchant reads stayed empty while their money waited. So every
   * escalation raises a request now, and the gateless ones raise the handover
   * ask (D-151, amending D-69).
   */
  /**
   * The card for a case that is simply *with a person* (D-151).
   *
   * Raised by the escalations no gate covers and by the Control Tower's own
   * "Escalate to me", which reaches this over the queue rather than by calling
   * approvals directly — `cases` may not depend on `approvals` without a
   * `forwardRef`, and the arrow that keeps "nothing reaches a customer except
   * through the Executor" true is worth more than a saved hop.
   *
   * The draft it carries is the next *written* rung the ladder would play,
   * skipping the channel that just failed where one did: asking somebody to
   * re-authorise the email that bounced a second ago is asking them to approve
   * a known failure.
   */
  async raiseHandover(
    caseId: number,
    reason: string,
    failed?: PolicyChannel,
  ): Promise<StepOutcome> {
    const record = await this.prisma.case.findUnique({
      where: { id: caseId },
      include: { customer: true },
    });

    if (!record) return { kind: "skipped", reason: `Case ${caseId} no longer exists` };
    if (record.stage !== "escalated") {
      return { kind: "skipped", reason: `Case is ${record.stage}, not escalated` };
    }

    await this.approvals.raise({
      caseId,
      gate: "escalated_to_human",
      channel: nextWrittenRung(record.type, record.rootCause, record.attemptsUsed, {
        phone: Boolean(record.customer.phone),
        email: Boolean(record.customer.email),
        avoid: failed,
      }),
      reason,
    });

    return { kind: "escalated", reason };
  }

  private async escalate(
    record: Case,
    reason: string,
    gate: ApprovalGate | null,
    channel?: PolicyChannel,
    concession: { concessionPaise?: number; discountPercent?: number } = {},
  ): Promise<StepOutcome> {
    // Read the stage now rather than trusting the copy this step began with:
    // `recordPlan` has already moved an escalated case back to `intervening` on
    // its way here, so the captured value says "escalated" while the row says
    // otherwise — and taking the append-only branch on it leaves a case that is
    // waiting on a human looking, on the pipeline, like one being worked (B-23).
    const current = await this.prisma.case.findUnique({
      where: { id: record.id },
      select: { stage: true },
    });

    if (current?.stage === "escalated") {
      await this.cases.appendEvent(record.id, escalatedEvent(reason, gate));
    } else {
      await this.cases.transition(record.id, "escalated", escalatedEvent(reason, gate));
    }

    if (gate) {
      await this.approvals.raise({
        caseId: record.id,
        gate,
        channel: channel ?? "WHATSAPP",
        concessionPaise: concession.concessionPaise || undefined,
        discountPercent: concession.discountPercent || undefined,
      });
    } else {
      await this.raiseHandover(record.id, reason, channel);
    }

    // The objection has now been put to a human. Clearing the flag is what
    // stops the planner asking the same question on every later rung — the ask
    // has been made, and whatever the answer is, it is theirs.
    if (gate === "discount_requires_approval") {
      await this.prisma.case.update({
        where: { id: record.id },
        data: { discountRequestedAt: null },
      });
    }

    return { kind: "escalated", reason };
  }

  private async close(
    record: Case,
    stage: "halted" | "exhausted",
    reason: string,
  ): Promise<StepOutcome> {
    await this.cases.transition(record.id, stage, {
      kind: "HALTED",
      title: stage === "halted" ? "Contact halted" : "Case exhausted",
      summary: reason,
      badge: { label: stage.toUpperCase(), tone: "halted" },
      body: {
        type: "facts",
        rows: [
          { label: "Outcome", value: stage.toUpperCase(), mono: true, tone: "halted" },
          { label: "Reason", value: reason },
          {
            label: "Attempts used",
            value: `${record.attemptsUsed} of ${record.attemptCap}`,
            mono: true,
          },
          {
            label: "Further contact",
            value: "None — the bound that closed this case is a stopping rule",
          },
        ],
      } as unknown as Prisma.InputJsonValue,
    });

    return { kind: "closed", stage, reason };
  }

  private async scheduleFollowUp(record: Case, channel: PolicyChannel): Promise<void> {
    const { pack } = await this.policy.getActive(record.merchantId);

    const delayMs =
      channel === "RETRY"
        ? record.type === "MANDATE_FAILED"
          ? pack.mandate.spacingDays * 24 * 60 * 60_000
          : RETRY_GAP_MS
        : pack.contact.coolDownHours * 60 * 60_000;

    await this.queue.enqueue(
      {
        kind: "case.step",
        caseId: record.id,
        jobId: `case:${record.id}:step:${record.attemptsUsed + 1}`,
        expectAttempt: record.attemptsUsed + 1,
        reason:
          channel === "RETRY"
            ? "Next rung once the retry gap expires"
            : "Next rung once the cool-down expires",
      },
      { delayMs },
    );
  }

  private async attemptsUsed(caseId: number): Promise<number> {
    const record = await this.prisma.case.findUnique({
      where: { id: caseId },
      select: { attemptsUsed: true },
    });
    return record?.attemptsUsed ?? 0;
  }
}

/* ------------------------------------------------------------------ */
/* Timeline bodies — shaped like the EventBody union in the frontend   */
/* ------------------------------------------------------------------ */

function retryEvent(
  record: Case,
  plan: PlanProposal,
  result: ChannelSendResult,
  detail: RetryDetail,
) {
  return {
    kind: EVENT_KIND.RETRY,
    title:
      record.type === "MANDATE_FAILED"
        ? `Mandate re-presented — ${plan.attempt} of 3 this cycle`
        : "Silent retry executed",
    summary: detail.captured
      ? `Captured ${inr(record.amountPaise)} rupees · ${result.channelRef}`
      : detail.awaiting
        ? `${detail.awaiting} · ${result.channelRef}`
        : `Declined again · ${detail.failureReason}`,
    badge: detail.captured
      ? { label: "captured", tone: "recovered" }
      : detail.awaiting
        ? { label: "awaiting capture", tone: "waiting" }
        : { label: "failed", tone: "halted" },
    body: {
      type: "facts",
      rows: [
        { label: "Payment", value: result.channelRef, mono: true },
        { label: "Against", value: record.originId ?? "—", mono: true },
        {
          label: "Result",
          value: detail.captured ? "captured" : detail.awaiting ? "awaiting webhook" : "failed",
          mono: true,
          tone: detail.captured ? "recovered" : detail.awaiting ? "waiting" : "halted",
        },
        ...(detail.link ? [{ label: "Payment link", value: detail.link, mono: true }] : []),
        { label: "Gateway latency", value: `${detail.gatewayLatencyMs} ms`, mono: true },
        { label: "Customer contacted", value: "No — silent retry" },
        { label: "Mode", value: channelModeLabel("RETRY", result.mode) },
      ],
    } as unknown as Prisma.InputJsonValue,
  };
}

function messageEvent(
  record: Case,
  customer: Customer,
  plan: PlanProposal,
  result: ChannelSendResult,
  detail: MessageDetail,
) {
  const whatsapp = detail.channel === "WHATSAPP";
  const to = whatsapp ? (customer.maskedPhone ?? "—") : (customer.maskedEmail ?? "—");

  return {
    kind: EVENT_KIND[detail.channel],
    title: whatsapp ? "WhatsApp nudge sent" : "Email sent",
    summary: `Attempt ${plan.attempt} of ${record.attemptCap} · to ${to}`,
    badge: { label: "delivered", tone: "neutral" },
    body: {
      type: "message",
      channel: detail.channel,
      subject: detail.subject,
      lines: detail.lines,
      link: detail.link,
      rows: [
        { label: "To", value: to, mono: true },
        ...(detail.template ? [{ label: "Template", value: detail.template, mono: true }] : []),
        { label: "Provider", value: channelModeLabel(detail.channel, result.mode) },
        { label: "Message id", value: result.channelRef, mono: true },
        { label: "Status", value: detail.status, mono: true },
        { label: "Cost", value: `${(result.costPaise / 100).toFixed(2)} rupees`, mono: true },
      ],
    } as unknown as Prisma.InputJsonValue,
  };
}

function voiceEvent(customer: Customer, result: ChannelSendResult, detail: VoiceDetail) {
  const real = result.mode === "real";
  const language = detail.language === "hi-IN" ? "Hinglish" : "English";
  return {
    kind: EVENT_KIND.VOICE,
    title: detail.pending ? "Voice call placed" : real ? "Voice call" : "Voice call placed",
    summary: detail.pending
      ? `${language} · ringing · the conversation is arriving over the voice webhooks`
      : `${language} · ${detail.seconds}s · intent ${detail.intent}`,
    badge: {
      label: real ? (detail.pending ? "real call · ringing" : "real call") : "simulated telephony",
      tone: "waiting",
    },
    body: {
      type: "voice",
      seconds: detail.seconds,
      transcript: detail.transcript,
      summary: detail.summary,
      intent: detail.intent,
      audioUrl: detail.audioUrl ?? null,
      recording: detail.recording ?? null,
      rows: [
        { label: "To", value: customer.maskedPhone ?? "—", mono: true },
        ...(detail.recording ? [{ label: "Recording", value: detail.recording }] : []),
        { label: "Language", value: detail.language, mono: true },
        { label: "Dialogue", value: `${detail.turnsFromModel} turns from the model`, mono: true },
        { label: "Call id", value: result.channelRef, mono: true },
        {
          label: "Telephony",
          value: real
            ? "Twilio Programmable Voice — a real call to the customer's phone"
            : "Simulated — the production path is Twilio/Exotel media streams",
        },
        { label: "Detected intent", value: detail.intent, mono: true },
      ],
    } as unknown as Prisma.InputJsonValue,
  };
}

function liveCallSummary(intent: VoiceIntent, context: LiveDialogueContext, providerStatus: string): string {
  switch (intent) {
    case "PROMISED_TO_PAY":
      return `Customer confirmed intent to pay and agreed a date on the call. Promise recorded for ${context.promiseDateLabel} at the full ${context.amountLabel}; a follow-up is scheduled for that morning.`;
    case "HARDSHIP_DECLARED":
      return "Customer said they cannot pay, or asked not to be called. Hardship language on the line, so the case went to a human and the agent stood down.";
    case "NO_COMMITMENT":
      return "The customer answered and the conversation ended without a date. The case stays on the ladder; the next rung is the next allowed contact.";
    default:
      return `Nobody picked up (${providerStatus}). No voicemail was left, and the per-channel cap of one voice call means there will not be another.`;
  }
}

function recoveredEvent(record: Case, channelRef: string) {
  return {
    kind: "RECOVERED" as const,
    title: `Recovered ${inr(record.amountPaise)} rupees`,
    summary: `Captured on a silent retry · ${channelRef}`,
    badge: { label: "recovered", tone: "recovered" },
    body: {
      type: "facts",
      rows: [
        {
          label: "Amount",
          value: `${inr(record.amountPaise)} rupees`,
          mono: true,
          tone: "recovered",
        },
        { label: "Payment", value: channelRef, mono: true },
        { label: "Attempts used", value: String(record.attemptsUsed + 1), mono: true },
        { label: "Customer contacted", value: "No — the case closed without a message" },
      ],
    } as unknown as Prisma.InputJsonValue,
  };
}

function escalatedEvent(reason: string, gate: ApprovalGate | null) {
  return {
    kind: "ESCALATED" as const,
    title: "Escalated to a human",
    summary: reason,
    badge: { label: "sent to approvals", tone: "waiting" },
    body: {
      type: "facts",
      rows: [
        ...(gate ? [{ label: "Gate", value: gate, mono: true }] : []),
        { label: "Reason", value: reason },
        { label: "Agent action", value: "Stood down — no further contact without a person" },
      ],
    } as unknown as Prisma.InputJsonValue,
  };
}

function contactFor(channel: PolicyChannel, customer: Customer): string {
  if (channel === "EMAIL") return customer.email ?? "";
  if (channel === "WHATSAPP" || channel === "VOICE") return customer.phone ?? "";
  return "";
}

/** "Fri 28 Aug" — the way the transcript and the promise row both say a date. */
function dayLabel(date: Date): string {
  return date.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}
