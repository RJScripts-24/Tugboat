import { Injectable, Logger } from "@nestjs/common";
import type { ApprovalGate, PolicyVerdict, Prisma } from "@prisma/client";

import { CaseEventsService, withSeqRetry } from "../cases/case-events.service";
import { toCaseRef } from "../common/case-ref";
import { ClockService } from "../common/clock.service";
import { PrismaService } from "../prisma/prisma.service";
import type { GatePass, GatePassClaims } from "./gate-pass";
import { formatClock, istMinuteOfDay } from "./ist-clock";
import {
  checkSummary,
  decisionRows,
  evaluateGate,
  type Evaluation,
  type FactRow,
  type GateAction,
  type GateSubject,
  type PolicyCheck,
} from "./policy-gate.evaluate";
import { CHANNEL_LABELS, POLICY_CHANNELS, type PolicyChannel } from "./policy-pack";
import { PolicyService } from "./policy.service";

export type GateResult = Evaluation & {
  decisionId: string;
  policyVersion: string;
  evaluatedInMs: number;
  rows: FactRow[];
  /**
   * Minted only on an allow. `PolicyGateService` is the sole issuer of this
   * type, and channel adapters require one, so an un-gated send does not
   * compile.
   */
  pass: GatePass | null;
};

/**
 * The gates that ask about the case rather than about one message.
 *
 * A yes to either is spent once and then holds. A discount and a hardship
 * stand-down are about a specific thing being offered, so they are asked every
 * time they come up.
 */
const ROUTING_GATES: ApprovalGate[] = ["b2b_high_value", "confidence_below_threshold"];

const VERDICT_TO_ENUM: Record<Evaluation["verdict"], PolicyVerdict> = {
  allowed: "ALLOWED",
  blocked: "BLOCKED",
  needs_approval: "NEEDS_APPROVAL",
};

@Injectable()
export class PolicyGateService {
  private readonly logger = new Logger(PolicyGateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly events: CaseEventsService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Checks one proposed action against the active policy pack and records the
   * verdict — including the allows.
   *
   * "Bounded" is only provable if the passes are logged as carefully as the
   * blocks (ADR-6): the evidence report's compliance figures are counted from
   * these rows rather than taken from the agent's word, and a gate that logged
   * only its refusals could not prove a single quiet hour was respected.
   */
  /**
   * What the gate would say, without saying it.
   *
   * Runs the identical evaluation as `check` and writes nothing — no decision
   * row, no timeline entry, no pass. It exists so the Control Tower can tell a
   * merchant which bounds are holding a call *before* they decide whether to
   * override them (D-160). A dialog that listed rules from a second, hand-kept
   * copy of the policy would be the B-79 bug with a nicer surface, so this
   * reuses `evaluateGate` rather than describing it.
   *
   * Deliberately not recorded: a question nobody acted on is not a decision,
   * and a compliance log filling up with hypotheticals is a log that buries the
   * real ones.
   */
  async preview(caseId: number, rawAction: GateAction): Promise<Evaluation> {
    const action: GateAction = { ...rawAction, at: rawAction.at ?? this.clock.now() };
    const { subject, pack, version } = await this.subjectFor(caseId);
    return evaluateGate(subject, action, pack, version);
  }

  async check(caseId: number, rawAction: GateAction): Promise<GateResult> {
    // Wall-clock, deliberately: this measures how long the evaluation took, and
    // a batch that has moved the agent's clock three days forward has not made
    // its own gate checks take three days.
    const startedAt = Date.now();

    // Every time comparison below reads the agent's clock rather than the
    // process's, so an accelerated batch proves quiet hours and cool-downs on
    // the same code a live case runs through.
    const action: GateAction = { ...rawAction, at: rawAction.at ?? this.clock.now() };

    const { subject, pack, version, policyVersionId, record } = await this.subjectFor(caseId);

    const evaluation = evaluateGate(subject, action, pack, version);
    const evaluatedInMs = Date.now() - startedAt;
    const rows = decisionRows(evaluation, version, evaluatedInMs);

    const decision = await this.record(
      record.id,
      action,
      evaluation,
      { policyVersionId, version },
      rows,
      evaluatedInMs,
    );

    this.logger.log(
      `${toCaseRef(record.id)} gate ${evaluation.verdict} for ${action.channel} · ${
        evaluation.outcome.kind === "allow" ? "no objection" : evaluation.outcome.reason
      }`,
    );

    return {
      ...evaluation,
      decisionId: decision.id,
      policyVersion: version,
      evaluatedInMs,
      rows,
      pass:
        evaluation.verdict === "allowed"
          ? mintPass({
              decisionId: decision.id,
              caseId: record.id,
              channel: action.channel,
              policyVersion: version,
              issuedAt: this.clock.now(),
            })
          : null,
    };
  }


  /**
   * Everything the evaluator needs about a case, gathered once.
   *
   * Extracted so `check` and `preview` cannot drift: the moment the two build
   * their subject differently, the dialog that tells a merchant what is
   * blocking a call stops describing the gate that will actually answer it.
   */
  private async subjectFor(caseId: number) {
    const record = await this.prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: {
        customer: true,
        // Only executed actions count against a bound: a planned-but-blocked
        // send never reached anybody and must not spend the case's rope.
        actions: { where: { status: "EXECUTED" }, orderBy: { executedAt: "desc" } },
        // A yes already given on this case, so a routing gate is not asked
        // again on the next rung.
        approvals: { where: { decision: "approved" }, select: { gate: true } },
      },
    });

    const { id: policyVersionId, version, pack } = await this.policy.getActive(record.merchantId);

    /*
     * The sends that still count against this case's bounds.
     *
     * Normally all of them. When a human has put the case back to the start
     * (D-157), only the ones since that instant: a restart is meant to reset
     * the channel caps, the cool-down and the re-presentation count, and all
     * three are derived from these rows rather than stored, so filtering here
     * resets all three in one place. Nothing is deleted — the case's timeline
     * still shows every message that went out, and the ledger still proves it.
     *
     * The bounds a restart does *not* touch are the ones that are not counted
     * from actions at all: the opt-out, the hardship flag, the deadline. Those
     * belong to the customer rather than to the agent's pacing.
     */
    const counted = record.restartedAt
      ? record.actions.filter(
          (entry) => entry.executedAt !== null && entry.executedAt >= record.restartedAt!,
        )
      : record.actions;

    const channelUsage = Object.fromEntries(
      POLICY_CHANNELS.map((channel) => [
        channel,
        counted.filter((entry) => entry.channel === channel).length,
      ]),
    ) as Record<PolicyChannel, number>;

    const contacts = counted.filter(
      (entry) => entry.channel !== null && entry.channel !== "RETRY",
    );
    const representations = counted.filter((entry) => entry.channel === "RETRY");

    const subject: GateSubject = {
      caseId: record.id,
      type: record.type,
      amountPaise: record.amountPaise,
      attemptsUsed: record.attemptsUsed,
      deadlineAt: record.deadlineAt,
      diagnosisConfidence: record.diagnosisConfidence,
      segment: record.customer.segment,
      optedOutAt: record.customer.optedOutAt,
      pausedAt: record.pausedAt,
      lastSentiment: record.lastSentiment,
      lastSentimentScore: record.lastSentimentScore,
      hardshipFlaggedAt: record.hardshipFlaggedAt,
      channelUsage,
      lastContactAt: contacts[0]?.executedAt ?? null,
      lastRepresentationAt: representations[0]?.executedAt ?? null,
      representationsThisCycle: representations.length,
      clearedGates: record.approvals
        .map((approval) => approval.gate)
        .filter((gate) => ROUTING_GATES.includes(gate)),
    };

    return { subject, pack, version, policyVersionId, record };
  }

  /**
   * The decision row and the timeline entry land in one transaction, for the
   * same reason a stage change and its event do (ADR-2): a verdict the case
   * history does not mention is a hole, and a timeline entry with no decision
   * row behind it is a claim with no record.
   */
  private async record(
    caseId: number,
    action: GateAction,
    evaluation: Evaluation,
    policy: { policyVersionId: string; version: string },
    rows: FactRow[],
    evaluatedInMs: number,
  ) {
    // Retried on a sequence collision like every other event writer: two
    // workers gating the same case at once must not lose a decision row (B-16).
    return withSeqRetry(
      () =>
        this.prisma.transaction(async (tx) => {
          const decision = await tx.policyDecision.create({
            data: {
              caseId,
              verdict: VERDICT_TO_ENUM[evaluation.verdict],
              checks: evaluation.checks as unknown as Prisma.InputJsonValue,
              policyVersionId: policy.policyVersionId,
              rescheduledFor: evaluation.rescheduledFor,
              evaluatedInMs,
            },
          });

          await this.events.append(tx, {
            caseId,
            kind: "POLICY_CHECK",
            ...timelineCopy(evaluation, action, policy.version),
            body: {
              type: "policy",
              checks: evaluation.checks as unknown as Prisma.InputJsonValue,
              rows: rows as unknown as Prisma.InputJsonValue,
            },
          });

          return decision;
        }),
      {
        onRetry: (attempt) =>
          this.logger.warn(`Event sequence collision on the gate; retrying (attempt ${attempt})`),
      },
    );
  }
}

/**
 * The one place a `GatePass` comes into existence.
 *
 * The brand has no runtime representation, so this cast is the only way to
 * produce the type; `architecture.spec.ts` asserts that no file outside this
 * module contains another one.
 */
function mintPass(claims: GatePassClaims): GatePass {
  return claims as GatePass;
}

function timelineCopy(
  evaluation: Evaluation,
  action: GateAction,
  version: string,
): { title: string; summary: string; badge?: { label: string; tone: string } } {
  const { passed, total } = checkSummary(evaluation.checks);
  const channel = CHANNEL_LABELS[action.channel].toLowerCase();

  if (evaluation.verdict === "allowed") {
    const clock = formatClock(istMinuteOfDay(action.at ?? new Date()));
    return {
      title: `Policy check — ${passed}/${total} passed`,
      summary: `PolicyGate ${version} cleared ${channel} for ${clock} IST`,
    };
  }

  if (evaluation.verdict === "needs_approval") {
    return {
      title: "Policy check — needs approval",
      summary: `${evaluation.outcome.kind === "approve" ? evaluation.outcome.reason : "Escalation gate"} · sent to the approvals queue`,
      badge: { label: "NEEDS APPROVAL", tone: "waiting" },
    };
  }

  return {
    title: "Policy check — blocked",
    summary: evaluation.outcome.kind === "allow" ? "Blocked" : evaluation.outcome.reason,
    badge: { label: "BLOCKED", tone: "halted" },
  };
}

export type { PolicyCheck };
