import type { ApprovalGate, CaseStage, CaseType, CustomerSegment, Sentiment } from "@prisma/client";

import { alignToPayday, formatClock, isQuiet, istMinuteOfDay, nextWindowOpen } from "./ist-clock";
import { CHANNEL_LABELS, SILENT_CHANNELS, type PolicyChannel, type PolicyPack } from "./policy-pack";

/**
 * PRD §9, as one pure function.
 *
 * Kept free of Prisma and Nest so the whole guardrail surface can be tested as
 * a table of inputs and expected verdicts: this is the code a compliance
 * reviewer would read, and it should be readable without a database running.
 */

export type CheckVerdict = "pass" | "block" | "skip";

/** Matches the frontend's PolicyCheck exactly — the Case Detail timeline renders these rows. */
export type PolicyCheck = { name: string; verdict: CheckVerdict; note: string };

export type FactRow = { label: string; value: string; mono?: boolean; tone?: string };

export type GateVerdict = "allowed" | "blocked" | "needs_approval";

export type GateOutcome =
  | { kind: "allow" }
  /** Contact ends for this customer. The case closes halted. */
  | { kind: "halt"; reason: string }
  /** The case has nothing left to spend. It closes exhausted. */
  | { kind: "exhaust"; reason: string }
  /** This action is refused; the case may still act another way. */
  | { kind: "refuse"; reason: string }
  /** The same action, later. */
  | { kind: "defer"; until: Date; reason: string }
  | { kind: "approve"; gate: ApprovalGate; reason: string };

export type GateSubject = {
  caseId: number;
  type: CaseType;
  amountPaise: number;
  attemptsUsed: number;
  deadlineAt: Date | null;
  diagnosisConfidence: number | null;
  segment: CustomerSegment;
  optedOutAt: Date | null;
  lastSentiment: Sentiment | null;
  lastSentimentScore: number | null;
  hardshipFlaggedAt: Date | null;
  channelUsage: Record<PolicyChannel, number>;
  lastContactAt: Date | null;
  lastRepresentationAt: Date | null;
  representationsThisCycle: number;
};

export type GateAction = {
  channel: PolicyChannel;
  /** Money the action gives away. Anything above zero is a person's decision, at any size. */
  concessionPaise?: number;
  /** The concession as a percentage of the case, where the ask is a discount. */
  discountPercent?: number;
  /** When the action would run. Defaults to now. */
  at?: Date;
};

export type Evaluation = {
  verdict: GateVerdict;
  outcome: GateOutcome;
  checks: PolicyCheck[];
  gate: ApprovalGate | null;
  rescheduledFor: Date | null;
  terminalStage: CaseStage | null;
};

/**
 * Terminal refusals outrank approvals, approvals outrank deferrals.
 *
 * The ordering is the product decision, not an implementation detail: an action
 * that both needs a human and falls inside quiet hours goes to the approvals
 * queue now, because the approver should not be kept waiting until 09:00 to be
 * asked — the Executor re-runs the gate at execution time and defers it then.
 */
const OUTCOME_RANK: Record<GateOutcome["kind"], number> = {
  halt: 0,
  exhaust: 1,
  refuse: 2,
  approve: 3,
  defer: 4,
  allow: 5,
};

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100));

const isoDay = (at: Date) => at.toISOString().slice(0, 10);

type Step = { check: PolicyCheck; outcome?: GateOutcome };

export function evaluateGate(
  subject: GateSubject,
  action: GateAction,
  pack: PolicyPack,
  policyVersion: string,
): Evaluation {
  const at = action.at ?? new Date();
  const silent = SILENT_CHANNELS.has(action.channel);
  const label = CHANNEL_LABELS[action.channel];

  const steps: Step[] = [
    quietHours(at, silent, pack, policyVersion),
    attemptCap(subject, pack, policyVersion),
    channelCap(subject, action.channel, label, pack),
    coolDown(subject, at, silent, pack),
    optOut(subject),
    sentimentHalt(subject, pack, policyVersion),
    escalationGate(subject, action, pack),
    channelEnabled(action.channel, label, pack, policyVersion),
    deadline(subject, at, pack, policyVersion),
  ];

  if (subject.type === "MANDATE_FAILED" && action.channel === "RETRY") {
    steps.push(representation(subject, at, pack));
  }

  const outcome = steps
    .map((step) => step.outcome)
    .filter((value): value is GateOutcome => value !== undefined)
    .sort((a, b) => OUTCOME_RANK[a.kind] - OUTCOME_RANK[b.kind])[0] ?? { kind: "allow" as const };

  return {
    verdict: toVerdict(outcome),
    outcome,
    checks: steps.map((step) => step.check),
    gate: outcome.kind === "approve" ? outcome.gate : null,
    rescheduledFor: outcome.kind === "defer" ? outcome.until : null,
    terminalStage: outcome.kind === "halt" ? "halted" : outcome.kind === "exhaust" ? "exhausted" : null,
  };
}

function toVerdict(outcome: GateOutcome): GateVerdict {
  if (outcome.kind === "allow") return "allowed";
  if (outcome.kind === "approve") return "needs_approval";
  return "blocked";
}

/* ------------------------------------------------------------------ */
/* The checks, in the order the timeline renders them                  */
/* ------------------------------------------------------------------ */

function quietHours(at: Date, silent: boolean, pack: PolicyPack, version: string): Step {
  const { startMinutes, endMinutes, exemptSilentRetries } = pack.quiet;

  if (silent && exemptSilentRetries) {
    return {
      check: {
        name: "Quiet hours",
        verdict: "skip",
        note: "Exempt — a silent retry contacts nobody",
      },
    };
  }

  const minute = istMinuteOfDay(at);
  const window = `${formatClock(startMinutes)}–${formatClock(endMinutes)}`;

  if (!isQuiet(minute, startMinutes, endMinutes)) {
    return {
      check: {
        name: "Quiet hours",
        verdict: "pass",
        note: `${formatClock(minute)} IST is inside the ${formatClock(endMinutes)}–${formatClock(startMinutes)} window`,
      },
    };
  }

  const until = nextWindowOpen(at, endMinutes);
  return {
    check: {
      name: "Quiet hours",
      verdict: "block",
      note: `Send fell at ${formatClock(minute)} IST, inside ${window} · rescheduled to ${formatClock(endMinutes)}`,
    },
    outcome: {
      kind: "defer",
      until,
      reason: `Quiet hours ${window} IST (TRAI DND-aligned, policy ${version})`,
    },
  };
}

function attemptCap(subject: GateSubject, pack: PolicyPack, version: string): Step {
  const max = pack.contact.maxAttempts;

  if (!pack.rules.attempt_cap) {
    return {
      check: {
        name: "Attempt cap",
        verdict: "skip",
        note: `Max-attempts exhaustion is switched off in policy ${version}`,
      },
    };
  }

  if (subject.attemptsUsed >= max) {
    return {
      check: {
        name: "Attempt cap",
        verdict: "block",
        note: `${subject.attemptsUsed} of ${max} used — the case has nothing left to spend`,
      },
      outcome: {
        kind: "exhaust",
        reason: `Attempt cap reached: ${subject.attemptsUsed} of ${max} used`,
      },
    };
  }

  return {
    check: {
      name: "Attempt cap",
      verdict: "pass",
      note: `${subject.attemptsUsed + 1} of ${max} used`,
    },
  };
}

function channelCap(
  subject: GateSubject,
  channel: PolicyChannel,
  label: string,
  pack: PolicyPack,
): Step {
  const cap = pack.contact.channelCaps[channel];
  const used = subject.channelUsage[channel] ?? 0;

  if (used >= cap) {
    return {
      check: {
        name: "Channel cap",
        verdict: "block",
        note: `${used} of ${cap} ${label.toLowerCase()} used — this channel is spent for the case`,
      },
      // Refused rather than exhausting: another rung of the ladder may still be open.
      outcome: { kind: "refuse", reason: `${label} cap reached: ${used} of ${cap}` },
    };
  }

  return {
    check: {
      name: "Channel cap",
      verdict: "pass",
      note: `${used + 1} of ${cap} ${label.toLowerCase()} used`,
    },
  };
}

function coolDown(subject: GateSubject, at: Date, silent: boolean, pack: PolicyPack): Step {
  if (silent) {
    return {
      check: {
        name: "Cool-down",
        verdict: "skip",
        note: "Exempt — a silent retry contacts nobody",
      },
    };
  }

  if (!subject.lastContactAt) {
    return { check: { name: "Cool-down", verdict: "pass", note: "First contact on this case" } };
  }

  const minimum = pack.contact.coolDownHours;
  const elapsed = (at.getTime() - subject.lastContactAt.getTime()) / HOUR_MS;

  if (elapsed < minimum) {
    return {
      check: {
        name: "Cool-down",
        verdict: "block",
        note: `${Math.floor(elapsed)}h since the last contact · minimum ${minimum}h`,
      },
      outcome: {
        kind: "defer",
        until: new Date(subject.lastContactAt.getTime() + minimum * HOUR_MS),
        reason: `Cool-down: ${Math.floor(elapsed)}h of ${minimum}h elapsed`,
      },
    };
  }

  return {
    check: {
      name: "Cool-down",
      verdict: "pass",
      note: `${Math.floor(elapsed)}h since the last contact · minimum ${minimum}h`,
    },
  };
}

/**
 * The only check with no skip branch.
 *
 * `pack.rules.opt_out` is typed as the literal `true`, so there is no pack in
 * which this is off and no code path that steps around it (PRD 9.4).
 */
function optOut(subject: GateSubject): Step {
  const optedOut = subject.optedOutAt !== null || subject.lastSentiment === "opt_out";

  if (optedOut) {
    return {
      check: {
        name: "Opt-out",
        verdict: "block",
        note: "STOP received — all channels closed for this customer, permanently",
      },
      outcome: { kind: "halt", reason: "Opt-out on record — contact refused on every channel" },
    };
  }

  return {
    check: {
      name: "Opt-out",
      verdict: "pass",
      note: "No opt-out on record for this customer",
    },
  };
}

function sentimentHalt(subject: GateSubject, pack: PolicyPack, version: string): Step {
  if (!pack.rules.sentiment) {
    return {
      check: {
        name: "Sentiment halt",
        verdict: "skip",
        note: `Negative-sentiment halt is switched off in policy ${version}`,
      },
    };
  }

  if (!subject.lastSentiment) {
    return { check: { name: "Sentiment halt", verdict: "pass", note: "No reply to classify yet" } };
  }

  const score = subject.lastSentimentScore ?? 0;
  const threshold = pack.sentimentThreshold;

  // Scores run -1..1, so "strongly negative" is at or below the negated
  // threshold — a mild grumble at -0.3 does not stop a case.
  if (subject.lastSentiment === "negative" && score <= -threshold) {
    return {
      check: {
        name: "Sentiment halt",
        verdict: "block",
        note: `Last reply classified negative at ${score.toFixed(2)} · halts at ${(-threshold).toFixed(2)}`,
      },
      outcome: {
        kind: "halt",
        reason: `Negative sentiment ${score.toFixed(2)} — handed to a person`,
      },
    };
  }

  return {
    check: {
      name: "Sentiment halt",
      verdict: "pass",
      note: `Last reply classified ${subject.lastSentiment.replace("_", "-")} at ${score.toFixed(2)}`,
    },
  };
}

function escalationGate(subject: GateSubject, action: GateAction, pack: PolicyPack): Step {
  const concession = action.concessionPaise ?? 0;
  const discountPercent = action.discountPercent ?? 0;
  const { discountCapPercent, valueThresholdPaise, b2bAlways, confidenceFloor, hardship } =
    pack.escalation;

  // A concession beyond what any human here may grant is refused outright:
  // queueing it would ask an approver for something they cannot give.
  if (concession > 0 && discountPercent > discountCapPercent) {
    return {
      check: {
        name: "Escalation gate",
        verdict: "block",
        note: `${discountPercent}% discount requested — above the ${discountCapPercent}% a human may approve`,
      },
      outcome: {
        kind: "refuse",
        reason: `Discount ${discountPercent}% exceeds the ${discountCapPercent}% approval cap`,
      },
    };
  }

  // The order of the gates below IS their precedence, and it is a product
  // decision: when several apply, the approvals queue should name the one that
  // most changes what the human ought to do. Hardship outranks a discount ask,
  // because "this person is in trouble" changes the answer to "may I give them
  // 10% off"; a routine value or B2B routing rule outranks nothing.
  if (hardship && subject.hardshipFlaggedAt) {
    return {
      check: {
        name: "Escalation gate",
        verdict: "block",
        note: "Hardship or dispute language on record — the case is handed over",
      },
      outcome: {
        kind: "approve",
        gate: "hardship_language",
        reason: "Hardship or dispute language detected",
      },
    };
  }

  if (concession > 0) {
    return {
      check: {
        name: "Escalation gate",
        verdict: "block",
        note: `₹${inr(concession)} concession requested — every discount needs a human`,
      },
      outcome: {
        kind: "approve",
        gate: "discount_requires_approval",
        reason: "Discount requested — there is no threshold under which Boa may give money away",
      },
    };
  }

  if (subject.diagnosisConfidence !== null && subject.diagnosisConfidence < confidenceFloor) {
    return {
      check: {
        name: "Escalation gate",
        verdict: "block",
        note: `Diagnosis confidence ${subject.diagnosisConfidence.toFixed(2)} is under the ${confidenceFloor.toFixed(2)} floor`,
      },
      outcome: {
        kind: "approve",
        gate: "confidence_below_threshold",
        reason: `Confidence ${subject.diagnosisConfidence.toFixed(2)} below the ${confidenceFloor.toFixed(2)} floor`,
      },
    };
  }

  if (subject.amountPaise > valueThresholdPaise) {
    return {
      check: {
        name: "Escalation gate",
        verdict: "block",
        note: `₹${inr(subject.amountPaise)} is over the ₹${inr(valueThresholdPaise)} approval threshold`,
      },
      outcome: {
        kind: "approve",
        gate: "b2b_high_value",
        reason: `Value ₹${inr(subject.amountPaise)} above the ₹${inr(valueThresholdPaise)} threshold`,
      },
    };
  }

  if (b2bAlways && subject.segment === "B2B") {
    return {
      check: {
        name: "Escalation gate",
        verdict: "block",
        note: "B2B account — receivables are worked by whoever owns the account",
      },
      outcome: {
        kind: "approve",
        gate: "b2b_high_value",
        reason: "B2B account — a business relationship is not a nudge target",
      },
    };
  }

  return {
    check: {
      name: "Escalation gate",
      verdict: "pass",
      note: `₹${inr(subject.amountPaise)} is under the ₹${inr(valueThresholdPaise)} approval threshold · no discount requested`,
    },
  };
}

function channelEnabled(
  channel: PolicyChannel,
  label: string,
  pack: PolicyPack,
  version: string,
): Step {
  if (!pack.channels[channel]) {
    return {
      check: {
        name: "Channel enabled",
        verdict: "block",
        note: `${label} is switched off in policy ${version}`,
      },
      outcome: { kind: "refuse", reason: `${label} is disabled in policy ${version}` },
    };
  }

  return {
    check: { name: "Channel enabled", verdict: "pass", note: `${label} is enabled in policy ${version}` },
  };
}

function deadline(subject: GateSubject, at: Date, pack: PolicyPack, version: string): Step {
  if (!pack.rules.deadline) {
    return {
      check: {
        name: "Deadline",
        verdict: "skip",
        note: `Deadline expiry is switched off in policy ${version}`,
      },
    };
  }

  if (!subject.deadlineAt) {
    return { check: { name: "Deadline", verdict: "pass", note: "No deadline set" } };
  }

  if (at.getTime() > subject.deadlineAt.getTime()) {
    return {
      check: {
        name: "Deadline",
        verdict: "block",
        note: `Deadline passed ${isoDay(subject.deadlineAt)} — stale debt is not chased`,
      },
      outcome: { kind: "exhaust", reason: `Deadline expired ${isoDay(subject.deadlineAt)}` },
    };
  }

  const daysLeft = Math.floor((subject.deadlineAt.getTime() - at.getTime()) / DAY_MS);
  return {
    check: {
      name: "Deadline",
      verdict: "pass",
      note: `Closes ${isoDay(subject.deadlineAt)} · ${daysLeft}d left`,
    },
  };
}

/**
 * RBI e-mandate discipline: a bounded number of re-presentations per cycle,
 * with mandatory spacing between them.
 *
 * "This cycle" is the case: a mandate case is opened per failed debit and its
 * retries are that debit's re-presentations. A real billing-cycle join needs
 * subscription period data the webhook does not carry.
 */
function representation(subject: GateSubject, at: Date, pack: PolicyPack): Step {
  const { maxPerCycle, spacingDays } = pack.mandate;
  const used = subject.representationsThisCycle;

  if (used >= maxPerCycle) {
    return {
      check: {
        name: "Re-presentation spacing",
        verdict: "block",
        note: `${used} of ${maxPerCycle} this cycle — the cycle's re-presentations are spent (RBI e-mandate discipline)`,
      },
      outcome: { kind: "refuse", reason: `Re-presentation cap reached: ${used} of ${maxPerCycle}` },
    };
  }

  if (!subject.lastRepresentationAt) {
    return {
      check: {
        name: "Re-presentation spacing",
        verdict: "pass",
        note: `${used + 1} of ${maxPerCycle} this cycle · first presentation (RBI e-mandate discipline)`,
      },
    };
  }

  const elapsedDays = (at.getTime() - subject.lastRepresentationAt.getTime()) / DAY_MS;

  if (elapsedDays < spacingDays) {
    const earliest = new Date(subject.lastRepresentationAt.getTime() + spacingDays * DAY_MS);
    const until = pack.mandate.alignToPayday ? alignToPayday(earliest) : earliest;

    return {
      check: {
        name: "Re-presentation spacing",
        verdict: "block",
        note: `${Math.floor(elapsedDays)} of ${spacingDays} clear days since the last presentation (RBI e-mandate discipline)`,
      },
      outcome: {
        kind: "defer",
        until,
        reason: `Re-presentation spacing: ${spacingDays} clear days required${
          until.getTime() !== earliest.getTime() ? ", aligned to payday" : ""
        }`,
      },
    };
  }

  return {
    check: {
      name: "Re-presentation spacing",
      verdict: "pass",
      note: `${used + 1} of ${maxPerCycle} this cycle · ${Math.floor(elapsedDays)} clear days since the last presentation (RBI e-mandate discipline)`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Timeline rendering                                                  */
/* ------------------------------------------------------------------ */

export function checkSummary(checks: PolicyCheck[]): { passed: number; total: number } {
  return {
    passed: checks.filter((check) => check.verdict === "pass").length,
    total: checks.filter((check) => check.verdict !== "skip").length,
  };
}

export function decisionRows(
  evaluation: Evaluation,
  policyVersion: string,
  evaluatedInMs: number,
): FactRow[] {
  const rows: FactRow[] = [
    { label: "Policy version", value: policyVersion, mono: true },
    {
      label: "Decision",
      value:
        evaluation.verdict === "allowed"
          ? "ALLOW"
          : evaluation.verdict === "needs_approval"
            ? "NEEDS APPROVAL"
            : "BLOCKED",
      mono: true,
      tone: evaluation.verdict === "allowed" ? undefined : "halted",
    },
    { label: "Evaluated in", value: `${evaluatedInMs} ms`, mono: true },
  ];

  if (evaluation.rescheduledFor) {
    rows.push({
      label: "Rescheduled to",
      value: `${evaluation.rescheduledFor.toISOString().slice(0, 16).replace("T", " ")} UTC`,
      mono: true,
    });
  }

  if (evaluation.gate) {
    rows.push({ label: "Gate", value: evaluation.gate, mono: true });
  }

  if (evaluation.terminalStage) {
    rows.push({ label: "Case closes", value: evaluation.terminalStage.toUpperCase(), mono: true, tone: "halted" });
  }

  return rows;
}
