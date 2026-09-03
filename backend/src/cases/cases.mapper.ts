import type { Action, Case, CaseEvent, CaseStage, Channel, Customer } from "@prisma/client";

import { toCaseRef } from "../common/case-ref";
import { maskedContact } from "../common/mask";
import type { PolicyPack } from "../policy/policy.service";

/**
 * Database rows to the shapes `frontend/src/lib/*-data.ts` already declares.
 *
 * The frontend is the contract (D-3), so field names and value spellings here
 * are copied from it rather than chosen. Anything this stage cannot yet know is
 * returned as an honest empty rather than an invented placeholder.
 */

function minutesAgo(date: Date): number {
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
}

/**
 * What the agent will do next, in the operator's words.
 *
 * Derived from the stage until the Planner exists (Stage 5), at which point the
 * real scheduled action replaces it. It describes the case honestly today
 * rather than promising a channel and a time nothing has decided yet.
 */
function nextActionLabel(record: Case, pendingApprovals: number): string {
  // A pause is the next action, because it is the reason there isn't one. The
  // column read "Waiting on the customer" on a case a merchant had just stood
  // the agent down on, which is how a button that works reads as one that does
  // not: the click landed, the ledger row landed, and the only surface the
  // merchant was looking at said nothing had changed (D-151).
  if (record.pausedAt && record.stage !== "escalated") {
    return "Paused by you · nothing will be sent";
  }

  switch (record.stage) {
    case "detected":
      return "Awaiting diagnosis";
    case "diagnosed":
      return "Planning intervention";
    case "intervening":
      return "Intervention in progress";
    case "waiting":
      return "Waiting on the customer";
    case "escalated":
      // Only when a card is genuinely open. A case escalated whose request has
      // been answered, or one escalated before B-85 taught the diagnoser to
      // raise one, is still with a person — but sending them to an empty queue
      // is the same broken promise as a button that does nothing.
      return pendingApprovals > 0
        ? "Waiting on you in Approvals"
        : "With you · no open request";
    case "promised":
      return "Promise check-in scheduled";
    case "halted":
      return "Halted · no further contact";
    case "exhausted":
      return "Closed at the attempt cap";
    default:
      return "—";
  }
}

export type PipelineCase = {
  id: string;
  type: Case["type"];
  customer: string;
  contact: string;
  amountPaise: number;
  rootCause: string;
  confidence: number | null;
  method: "RULES" | "LLM" | null;
  stage: CaseStage;
  nextAction: string;
  attempts: number;
  attemptCap: number;
  updatedMinutesAgo: number;
  recoveredPaise: number;
  /**
   * Requests on this case still waiting for an answer.
   *
   * On the wire because the status badge is a claim about the queue, not only
   * about the stage. A case sits in `escalated` from the moment the agent
   * stands down until something moves it, and that span is longer than the one
   * its card is open for: the request is answered, the release then fails, and
   * the row goes on reading "Escalated" over an empty Approvals page (B-88).
   * The badge reads the same table the queue reads, so the two surfaces cannot
   * disagree about whether a question is outstanding.
   */
  openApprovals: number;
};

export function toPipelineCase(
  record: Case & { customer: Customer; approvals?: { id: string }[] },
): PipelineCase {
  // `CASE_INCLUDE` filters this relation to `decision: null`, so its length is
  // the number of *open* requests rather than the number ever raised.
  const openApprovals = record.approvals?.length ?? 0;

  return {
    id: toCaseRef(record.id),
    type: record.type,
    customer: record.customer.name,
    contact: maskedContact(record.customer),
    amountPaise: record.amountPaise,
    // The contract's RootCause union has no null: an undiagnosed case reads as
    // UNKNOWN, and the null confidence beside it is what says "not yet looked at".
    rootCause: record.rootCause ?? "UNKNOWN",
    confidence: record.diagnosisConfidence,
    method: record.diagnosisMethod,
    stage: record.stage,
    nextAction: nextActionLabel(record, openApprovals),
    attempts: record.attemptsUsed,
    attemptCap: record.attemptCap,
    updatedMinutesAgo: minutesAgo(record.updatedAt),
    recoveredPaise: record.recoveredAmountPaise,
    openApprovals,
  };
}

export function toTimelineEvent(event: CaseEvent) {
  return {
    id: String(event.id),
    seq: event.seq,
    kind: event.kind,
    minutesAgo: minutesAgo(event.occurredAt),
    title: event.title,
    summary: event.summary,
    badge: event.badgeLabel ? { label: event.badgeLabel, tone: event.badgeTone ?? "neutral" } : undefined,
    body: event.body ?? undefined,
  };
}

/** The event kind a scheduled action will write when it runs. */
const PENDING_KIND: Record<Channel, CaseEvent["kind"]> = {
  EMAIL: "EMAIL_SENT",
  WHATSAPP: "WHATSAPP_SENT",
  VOICE: "VOICE_CALL",
  RETRY: "RETRY_EXECUTED",
};

const PENDING_LABEL: Record<Channel, string> = {
  EMAIL: "Email",
  WHATSAPP: "WhatsApp nudge",
  VOICE: "Voice call",
  RETRY: "Silent retry",
};

/**
 * A scheduled action, as the greyed-out node at the end of the timeline.
 *
 * The contract says pending events carry `minutesAgo: 0`, which is the honest
 * value: this has not happened, so there is no elapsed time to state. When it
 * *does* happen it will be written as a real event by the Executor, with its
 * own sequence number — this projection is never persisted, which is what
 * stops a plan that was later blocked from leaving a fossil in the log.
 */
export function toPendingEvent(action: Action, seq: number) {
  const channel = action.channel ?? "RETRY";
  const when = action.scheduledFor;

  return {
    id: `pending-${action.id}`,
    seq,
    kind: PENDING_KIND[channel],
    minutesAgo: 0,
    title: `${PENDING_LABEL[channel]} scheduled`,
    summary: when
      ? `Attempt ${action.attempt} · due ${when.toISOString().slice(0, 16).replace("T", " ")} UTC · the gate runs again first`
      : `Attempt ${action.attempt} · queued · the gate runs again first`,
    badge: { label: "SCHEDULED", tone: "neutral" },
    body: {
      type: "facts",
      rows: [
        { label: "Channel", value: PENDING_LABEL[channel] },
        { label: "Attempt", value: String(action.attempt), mono: true },
        {
          label: "Due",
          value: when ? when.toISOString() : "next drain",
          mono: true,
        },
        {
          label: "Before it runs",
          value: "The PolicyGate re-evaluates — a case that opted out in the meantime is not sent to",
        },
      ],
    },
  };
}

function clockLabel(minutes: number): string {
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function toCustomerProfile(customer: Customer) {
  const hinglish = customer.languagePref.startsWith("hi");

  return {
    name: customer.name,
    // Masked, always — Case Detail is a screen-share surface.
    phone: customer.maskedPhone ?? "—",
    email: customer.maskedEmail ?? "—",
    language: hinglish ? "hi-IN · Hinglish" : "en-IN · English",
    languageNote: hinglish
      ? "Nudges and the voice script are written code-mixed"
      : "Nudges and the voice script are written in English",
    timezone: "Asia/Kolkata · IST",
    segment: customer.segment,
    history: customer.optedOutAt ? "Opted out of contact" : "No opt-out on record",
  };
}

export function toOrigin(record: Case) {
  const id = record.originId ?? "—";
  const path = record.type === "MANDATE_FAILED" ? "subscriptions" : "payments";

  return {
    kind: record.originKind ?? "Razorpay object",
    id,
    href: `https://dashboard.razorpay.com/app/${path}/${id}`,
    reference: record.originRef ?? "—",
  };
}

export function toBounds(
  record: Case,
  customer: Customer,
  policy: { version: string; pack: PolicyPack },
  channelUsage: Record<string, number>,
) {
  const { pack } = policy;
  const closed = ["recovered", "halted", "exhausted"].includes(record.stage);

  return {
    attemptsUsed: record.attemptsUsed,
    // The pack, not the case's own column: the PolicyGate enforces the active
    // pack's bound, and a panel showing a different number from the one being
    // enforced is a demo bug waiting to be found on stage.
    attemptCap: pack.contact.maxAttempts,
    channels: Object.entries(pack.contact.channelCaps).map(([channel, cap]) => ({
      channel,
      used: channelUsage[channel] ?? 0,
      cap,
    })),
    quietHours: `${clockLabel(pack.quiet.endMinutes)}–${clockLabel(pack.quiet.startMinutes)}`,
    quietNote: pack.quiet.exemptSilentRetries
      ? "TRAI DND-aligned · silent retries exempt"
      : "TRAI DND-aligned",
    optedOut: customer.optedOutAt !== null,
    optOutNote: customer.optedOutAt
      ? "STOP received — all channels closed permanently"
      : "No opt-out on record for this customer",
    // Cool-down is measured from the last contact, and no contact has been sent
    // until the Executor exists (Stage 5).
    coolDownMinutesLeft: null,
    coolDownNote: `Minimum ${pack.contact.coolDownHours}h between contacts`,
    deadlineNote: record.deadlineAt
      ? `Closes ${record.deadlineAt.toISOString().slice(0, 10)}`
      : "No deadline set",
    policyVersion: policy.version,
    closed,
    closedNote: closed ? `Case closed as ${record.stage}` : null,
  };
}

export function toOutcome(
  record: Case,
  counts: { contacts: number; llmCalls: number; llmTokens: number },
  pendingApprovals = 0,
) {
  const recovered = record.recoveredAmountPaise > 0;

  return {
    stage: record.stage,
    headline: recovered
      ? `Recovered ₹${Math.round(record.recoveredAmountPaise / 100)}`
      : `₹${Math.round(record.amountPaise / 100)} still at risk`,
    detail: nextActionLabel(record, pendingApprovals),
    atRiskPaise: record.amountPaise,
    recoveredPaise: record.recoveredAmountPaise,
    timeToRecoveryMinutes: recovered
      ? Math.max(0, Math.round((record.updatedAt.getTime() - record.createdAt.getTime()) / 60_000))
      : null,
    contacts: counts.contacts,
    llmCalls: counts.llmCalls,
    llmTokens: counts.llmTokens,
    spentPaise: record.costPaise,
    // Production-price projection is computed by the metrics module (Stage 8);
    // reporting zero here is accurate, since nothing has been spent yet.
    projectedLlmPaise: 0,
    projectedChannelPaise: 0,
  };
}
