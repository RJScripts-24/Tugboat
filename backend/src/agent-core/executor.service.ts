import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Action, Case, Customer, Prisma } from "@prisma/client";

import {
  CHANNEL_ADAPTERS,
  CHANNEL_MODE_LABEL,
  type ChannelAdapter,
  type ChannelSendResult,
  type MessageDetail,
  type RetryDetail,
  type VoiceCounterpart,
  type VoiceDetail,
} from "../channels/channel-adapter.interface";
import { isUniqueViolation } from "../cases/case-events.service";
import { CasesService } from "../cases/cases.service";
import { toCaseRef } from "../common/case-ref";
import { PolicyGateService } from "../policy/policy-gate.service";
import type { PolicyChannel } from "../policy/policy-pack";
import { PolicyService } from "../policy/policy.service";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE, type ActionQueue } from "../queue/action-queue.interface";
import { NoPlanAvailableError, PlannerService, type PlanProposal } from "./planner.service";

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
   * Refuse to run if the case has already moved past this attempt. Set from the
   * queued job, so a redelivery is a no-op rather than an extra contact.
   */
  expectAttempt?: number;
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
    @Inject(CHANNEL_ADAPTERS) private readonly adapters: Map<string, ChannelAdapter>,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
  ) {}

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

    const refused: PolicyChannel[] = [];

    for (let attempt = 0; attempt < MAX_ALTERNATIVES; attempt += 1) {
      let plan: PlanProposal;
      try {
        plan = this.planner.propose(record, { exclude: refused });
      } catch (error) {
        if (!(error instanceof NoPlanAvailableError)) throw error;
        return this.close(record, "exhausted", "Every channel in the playbook was refused");
      }

      await this.recordPlan(record, plan);

      const verdict = await this.gate.check(caseId, { channel: plan.channel });

      if (verdict.outcome.kind === "allow") {
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
          },
          { delayMs: Math.max(0, until.getTime() - Date.now()) },
        );
        return { kind: "deferred", until, reason };
      }

      if (verdict.outcome.kind === "approve") {
        return this.escalate(record, verdict.outcome.reason, verdict.outcome.gate);
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
    const adapter = this.adapters.get(plan.channel);
    if (!adapter) throw new Error(`No adapter registered for channel ${plan.channel}`);

    const claim = await this.claim(record.id, plan);
    if (!claim.proceed) return { kind: "skipped", reason: claim.reason };

    const copy = this.planner.copyContext(record, customer, merchantName, plan.attempt);
    const promiseDate = new Date(Date.now() + PROMISE_HORIZON_MS);

    let result: ChannelSendResult;
    try {
      result = await adapter.send(pass, {
        caseId: record.id,
        attempt: plan.attempt,
        to: contactFor(plan.channel, customer),
        copy,
        counterpart: options.counterpart,
        promiseDateLabel: dayLabel(promiseDate),
      });
    } catch (error) {
      return this.failAction(record, claim.action, plan, (error as Error).message);
    }

    await this.prisma.action.update({
      where: { id: claim.action.id },
      data: {
        status: "EXECUTED",
        executedAt: new Date(),
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
      await this.cases.transition(record.id, "recovered", retryEvent(record, plan, result, detail), {
        ...spend,
        recoveredAmountPaise: record.amountPaise,
      });
      await this.cases.appendEvent(record.id, recoveredEvent(record, result.channelRef));
      this.logger.log(`${toCaseRef(record.id)} RECOVERED ${inr(record.amountPaise)} rupees`);
      return {
        kind: "sent",
        channel: plan.channel,
        channelRef: result.channelRef,
        stage: "recovered",
      };
    }

    if (detail.kind === "voice" && detail.intent === "PROMISED_TO_PAY") {
      await this.cases.transition(
        record.id,
        "promised",
        voiceEvent(customer, result, detail),
        spend,
      );
      await this.recordPromise(record, promiseDate);
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
        hardshipFlaggedAt: new Date(),
      });
      await this.cases.appendEvent(
        record.id,
        escalatedEvent("Hardship language on the call — the agent stood down", "hardship_language"),
      );
      return { kind: "escalated", reason: "Hardship declared on the call" };
    }

    const event =
      detail.kind === "retry"
        ? retryEvent(record, plan, result, detail)
        : detail.kind === "voice"
          ? voiceEvent(customer, result, detail)
          : messageEvent(record, customer, plan, result, detail);

    await this.cases.transition(record.id, "waiting", event, spend);
    await this.scheduleFollowUp(record, plan.channel);

    return { kind: "sent", channel: plan.channel, channelRef: result.channelRef, stage: "waiting" };
  }

  private async recordPromise(record: Case, promiseDate: Date): Promise<void> {
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
        daysAway: Math.max(1, Math.round((promiseDate.getTime() - Date.now()) / 86_400_000)),
        rows: [
          { label: "Amount", value: `${inr(record.amountPaise)} rupees`, mono: true },
          { label: "Promised for", value: dayLabel(promiseDate), mono: true },
          { label: "Heard on", value: "Voice call · simulated telephony" },
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
      { delayMs: Math.max(0, promiseDate.getTime() - Date.now()) },
    );
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
        data: { status: "KEPT", resolvedAt: new Date() },
      });
      return { kind: "skipped", reason: "Promise kept — the case had already recovered" };
    }

    await this.prisma.paymentPromise.update({
      where: { id: promiseId },
      data: { status: "BROKEN", resolvedAt: new Date() },
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
  /* Endings                                                           */
  /* ---------------------------------------------------------------- */

  private async escalate(record: Case, reason: string, gate: string | null): Promise<StepOutcome> {
    if (record.stage === "escalated") {
      await this.cases.appendEvent(record.id, escalatedEvent(reason, gate));
    } else {
      await this.cases.transition(record.id, "escalated", escalatedEvent(reason, gate));
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
      : `Declined again · ${detail.failureReason}`,
    badge: {
      label: detail.captured ? "captured" : "failed",
      tone: detail.captured ? "recovered" : "halted",
    },
    body: {
      type: "facts",
      rows: [
        { label: "Payment", value: result.channelRef, mono: true },
        { label: "Against", value: record.originId ?? "—", mono: true },
        {
          label: "Result",
          value: detail.captured ? "captured" : "failed",
          mono: true,
          tone: detail.captured ? "recovered" : "halted",
        },
        { label: "Gateway latency", value: `${detail.gatewayLatencyMs} ms`, mono: true },
        { label: "Customer contacted", value: "No — silent retry" },
        { label: "Mode", value: CHANNEL_MODE_LABEL.RETRY },
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
        { label: "Provider", value: CHANNEL_MODE_LABEL[detail.channel] },
        { label: "Message id", value: result.channelRef, mono: true },
        { label: "Status", value: detail.status, mono: true },
        { label: "Cost", value: `${(result.costPaise / 100).toFixed(2)} rupees`, mono: true },
      ],
    } as unknown as Prisma.InputJsonValue,
  };
}

function voiceEvent(customer: Customer, result: ChannelSendResult, detail: VoiceDetail) {
  return {
    kind: EVENT_KIND.VOICE,
    title: "Voice call placed",
    summary: `${detail.language === "hi-IN" ? "Hinglish" : "English"} · ${detail.seconds}s · intent ${detail.intent}`,
    badge: { label: "simulated telephony", tone: "waiting" },
    body: {
      type: "voice",
      seconds: detail.seconds,
      transcript: detail.transcript,
      summary: detail.summary,
      intent: detail.intent,
      rows: [
        { label: "To", value: customer.maskedPhone ?? "—", mono: true },
        { label: "Language", value: detail.language, mono: true },
        { label: "Dialogue", value: `${detail.turnsFromModel} turns from the model`, mono: true },
        { label: "Call id", value: result.channelRef, mono: true },
        {
          label: "Telephony",
          value: "Simulated — the production path is Twilio/Exotel media streams",
        },
        { label: "Detected intent", value: detail.intent, mono: true },
      ],
    } as unknown as Prisma.InputJsonValue,
  };
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

function escalatedEvent(reason: string, gate: string | null) {
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
