import type { CaseType, CustomerSegment, RootCause } from "@prisma/client";

import { payLink, razorpayPaymentId } from "../channels/channel-refs";
import {
  discountCopy,
  emailCopy,
  hardshipCopy,
  whatsappCopy,
  type CopyContext,
} from "../channels/message-copy";
import type { PolicyChannel, PolicyPack } from "../policy/policy-pack";

/**
 * The ask a human is being handed, assembled once and stored.
 *
 * Everything on an approval card is written at the moment the gate refuses and
 * persisted with the row, rather than re-derived when the queue is read. That
 * is the whole difference between an approval and a suggestion: the merchant
 * approves the message that existed when Boa stopped, not a message rebuilt
 * later from a case that may have moved. It also means the History tab can
 * still show what was asked long after the case closed and the copy changed.
 *
 * Shapes mirror `frontend/src/lib/approvals-data.ts` field for field (D-3).
 */

/** The four gates of PRD §9.6, plus the one a person opens themselves (D-151). */
export type ApprovalGateName =
  | "discount_requires_approval"
  | "b2b_high_value"
  | "confidence_below_threshold"
  | "hardship_language"
  | "escalated_to_human";

export type PolicyChip = { label: string; tone?: string };

export type DraftMessage = {
  channel: PolicyChannel;
  to: string;
  subject?: string;
  lines: string[];
  link?: string;
  /** What executing it actually does, in one line. */
  note: string;
};

export type ResumeStep = { label: string; detail: string };

export type Candidate = { label: string; probability: number };

export type Ask = {
  headline: string;
  justification: string[];
  chips: PolicyChip[];
  draft: DraftMessage;
  candidates: Candidate[];
  concessionPaise: number;
  ifApproved: string;
  ifRejected: string;
  resumeSteps: ResumeStep[];
};

/**
 * Everything the ask needs, flattened off the case, its customer and the plan
 * the gate stopped. A plain object rather than Prisma rows so the builder is a
 * pure function with a table-driven test.
 */
export type AskSubject = {
  caseId: number;
  type: CaseType;
  rootCause: RootCause | null;
  amountPaise: number;
  attemptsUsed: number;
  attemptCap: number;
  confidence: number | null;
  segment: CustomerSegment;
  customerName: string;
  merchantName: string;
  hinglish: boolean;
  /** Masked — an approval card is the most screen-shared surface in the product. */
  contact: string;
  failureCode: string | null;
  originId: string | null;
  lastSentimentScore: number | null;
  /** The rung the planner wanted when the gate refused it. */
  channel: PolicyChannel;
  /**
   * Why the case is sitting with a person, in the words the escalation used.
   * Only the handover gate has one — the other four *are* the reason.
   */
  handoverReason?: string | null;
};

/** The concession Boa asks for when it asks at all. Capped by policy at 15%. */
export const DISCOUNT_PERCENT = 12;

/** Below this a payment plan costs more to administer than it recovers. */
const PLAN_FLOOR_PAISE = 1_000 * 100;

const ROOT_CAUSE_LABELS: Record<RootCause, string> = {
  BANK_GATEWAY_DEGRADED: "Bank/gateway degraded",
  INSUFFICIENT_FUNDS: "Insufficient funds",
  CUSTOMER_DISTRACTED: "Customer distracted",
  CARD_EXPIRED: "Card expired",
  MANDATE_REVOKED: "Mandate revoked",
  UNKNOWN: "Unmapped — needs a human",
};

const TYPE_NOUN: Record<CaseType, string> = {
  PAYMENT_FAILED: "payment",
  CHECKOUT_ABANDONED: "cart",
  MANDATE_FAILED: "subscription debit",
  INVOICE_OVERDUE: "invoice",
};

/** Which cause the model would have reached for, had it been confident. */
const CANDIDATE_POOL: Record<CaseType, RootCause[]> = {
  PAYMENT_FAILED: ["BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS", "CARD_EXPIRED"],
  CHECKOUT_ABANDONED: ["CUSTOMER_DISTRACTED", "BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS"],
  MANDATE_FAILED: ["INSUFFICIENT_FUNDS", "MANDATE_REVOKED", "BANK_GATEWAY_DEGRADED"],
  INVOICE_OVERDUE: ["CUSTOMER_DISTRACTED", "INSUFFICIENT_FUNDS", "BANK_GATEWAY_DEGRADED"],
};

const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100));

const money = (paise: number) => `₹${inr(paise)}`;

function copyContext(subject: AskSubject): CopyContext {
  return {
    caseId: subject.caseId,
    type: subject.type,
    rootCause: subject.rootCause,
    amountPaise: subject.amountPaise,
    customerName: subject.customerName,
    merchantName: subject.merchantName,
    hinglish: subject.hinglish,
    attempt: subject.attemptsUsed + 1,
  };
}

export function buildAsk(subject: AskSubject, gate: ApprovalGateName, pack: PolicyPack): Ask {
  switch (gate) {
    case "discount_requires_approval":
      return discountAsk(subject, pack);
    case "hardship_language":
      return hardshipAsk(subject);
    case "b2b_high_value":
      return b2bAsk(subject, pack);
    case "escalated_to_human":
      return handoverAsk(subject, pack);
    default:
      return confidenceAsk(subject, pack);
  }
}

/* ------------------------------------------------------------------ */
/* Any discount → a human, at any size                                 */
/* ------------------------------------------------------------------ */

function discountAsk(subject: AskSubject, pack: PolicyPack): Ask {
  const concession = Math.round((subject.amountPaise * DISCOUNT_PERCENT) / 100);
  const net = subject.amountPaise - concession;
  const noun = TYPE_NOUN[subject.type];
  const link = payLink(subject.caseId);
  const attempts = subject.attemptsUsed;

  return {
    headline: `Offer ${DISCOUNT_PERCENT}% off (${money(concession)}) to recover the ${money(
      subject.amountPaise,
    )} ${noun}`,
    justification: [
      `${attempts} nudge${attempts === 1 ? "" : "s"} ${
        attempts === 1 ? "has" : "have"
      } gone unanswered on this case and the ${noun} is still open.`,
      `${DISCOUNT_PERCENT}% is inside the ${pack.escalation.discountCapPercent}% margin cap, so this is the smallest ask that plausibly closes ${money(
        subject.amountPaise,
      )} — but Boa may not give money away at any size, so the call is yours.`,
    ],
    chips: [
      { label: "any discount → human", tone: "waiting" },
      { label: `${DISCOUNT_PERCENT}% ≤ ${pack.escalation.discountCapPercent}% cap` },
      { label: `${attempts} of ${subject.attemptCap} attempts` },
      { label: "inside 09:00–21:00" },
    ],
    concessionPaise: concession,
    candidates: [],
    draft: {
      channel: "WHATSAPP",
      to: subject.contact,
      lines: discountCopy(copyContext(subject), DISCOUNT_PERCENT),
      link,
      note: `WhatsApp · payment link ${link} for ${money(net)} after the ${DISCOUNT_PERCENT}% off`,
    },
    ifApproved: `Boa re-runs the policy gate, sends this message, and reopens the case at attempt ${
      attempts + 1
    } of ${subject.attemptCap}.`,
    ifRejected: `Boa stands down on the concession and carries on with the standard playbook; the ${noun} closes at its deadline if nothing lands.`,
    resumeSteps: [
      {
        label: "Policy re-check",
        detail: "The gate re-runs against the approved discount, not the blocked one",
      },
      {
        label: "WhatsApp sent",
        detail: `Payment link ${link} · ${money(net)} after the ${DISCOUNT_PERCENT}% off`,
      },
      {
        label: "Case resumed",
        detail: `Attempt ${attempts + 1} of ${subject.attemptCap} · ${pack.contact.coolDownHours}h cool-down starts now`,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Hardship → the agent has already stopped                            */
/* ------------------------------------------------------------------ */

function hardshipAsk(subject: AskSubject): Ask {
  const plan = subject.amountPaise >= PLAN_FLOOR_PAISE;
  const instalment = Math.round(subject.amountPaise / 3);
  const email = plan && subject.segment === "B2B";
  const score = subject.lastSentimentScore;

  const body = hardshipCopy(copyContext(subject), {
    plan,
    instalmentPaise: instalment,
    email,
  });

  return {
    headline: plan
      ? `Pause 30 days and offer 3 × ${money(instalment)} on ${money(subject.amountPaise)}`
      : `Close ${money(subject.amountPaise)} with one acknowledgement and no further contact`,
    justification: [
      score === null
        ? `A reply on this case carried hardship or dispute language. Boa stopped on the spot: nothing has gone out since.`
        : `The reply on this case carried hardship language and the classifier scored it ${score.toFixed(
            2,
          )} — inside the halt band. Boa stopped on the spot: nothing has gone out since.`,
      plan
        ? `A plan keeps the relationship and most of the money, where another reminder would recover neither. It needs a human because Boa may not offer terms on its own.`
        : `${money(
            subject.amountPaise,
          )} does not justify a payment plan or a chase. The honest ask is to acknowledge, close, and stop.`,
    ],
    chips: [
      { label: "hardship → human", tone: "halted" },
      { label: "contact already halted", tone: "halted" },
      ...(score === null ? [] : [{ label: `sentiment ${score.toFixed(2)}` }]),
      { label: `${subject.attemptsUsed} of ${subject.attemptCap} attempts` },
      { label: "opt-out honoured" },
    ],
    concessionPaise: 0,
    candidates: [],
    draft: {
      channel: email ? "EMAIL" : "WHATSAPP",
      to: subject.contact,
      subject: body.subject,
      lines: body.lines,
      note: plan
        ? "One message, then a 30-day contact block enforced at the gate — not a reminder schedule"
        : "One acknowledgement, then the case closes and the customer is left alone",
    },
    ifApproved: plan
      ? "Boa sends this once and closes the case as handled. No reminder schedule is created."
      : "Boa sends this once and closes the case. No further contact is possible on it.",
    ifRejected:
      "Boa stays stood down either way — a rejection only means the message above is not sent, and the case closes silently.",
    resumeSteps: [
      {
        label: "Policy re-check",
        detail: "Hardship block confirmed · this case may never be chased again",
      },
      {
        label: "Message sent",
        detail: plan
          ? "Plan offered once, with no follow-up scheduled"
          : "Acknowledgement sent, with no follow-up scheduled",
      },
      {
        label: "Case closed",
        detail: "Closed as handled · no further contact",
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Under the confidence floor → Boa will not guess                     */
/* ------------------------------------------------------------------ */

function confidenceAsk(subject: AskSubject, pack: PolicyPack): Ask {
  const floor = pack.escalation.confidenceFloor;
  const confidence = subject.confidence ?? 0;
  const untouched = subject.attemptsUsed === 0;
  const pool = CANDIDATE_POOL[subject.type];
  const [first, second] = pool;
  const link = payLink(subject.caseId);

  // The model's leftover mass, split between its runner-up and "I do not know".
  const secondP = Math.max(0.08, round2(confidence * 0.6));
  const rest = Math.max(0.05, round2(1 - confidence - secondP));

  const errorCode = subject.failureCode ?? "UNMAPPED";
  const origin = subject.originId ?? razorpayPaymentId(subject.caseId, 1);

  return {
    headline: untouched
      ? `Confirm a root cause on ${money(subject.amountPaise)} before anything is sent`
      : `Release one last attempt on ${money(subject.amountPaise)} without a diagnosis`,
    justification: [
      `The gateway returned a reason code (${errorCode}) the rules table has no entry for. The model's best read is ${ROOT_CAUSE_LABELS[
        first
      ].toLowerCase()} at ${confidence.toFixed(2)}, under the ${floor.toFixed(2)} floor.`,
      untouched
        ? `Nothing has been sent on this case and nothing will be: under the floor Boa escalates rather than guesses, because a wrong diagnosis sends the wrong message to a customer who did nothing wrong.`
        : `${subject.attemptsUsed} attempts have run on the generic playbook without a diagnosis. Boa will not spend another on a guess, so the call is yours.`,
    ],
    chips: [
      {
        label: `confidence ${confidence.toFixed(2)} < ${floor.toFixed(2)}`,
        tone: "diagnosis",
      },
      { label: "no diagnosis written" },
      { label: `${subject.attemptsUsed} of ${subject.attemptCap} attempts` },
      { label: untouched ? "nothing sent yet" : "cool-down clear" },
    ],
    concessionPaise: 0,
    candidates: [
      { label: ROOT_CAUSE_LABELS[first], probability: round2(confidence) },
      { label: ROOT_CAUSE_LABELS[second], probability: secondP },
      { label: ROOT_CAUSE_LABELS.UNKNOWN, probability: rest },
    ],
    draft: untouched
      ? {
          channel: "RETRY",
          to: origin,
          lines: [
            `POST /v1/payments/${origin}/retry`,
            `{ "amount": ${subject.amountPaise}, "currency": "INR", "idempotency_key": "case:${subject.caseId}:RETRY:1" }`,
            `No customer contact. If it fails again, Boa stops and comes back here.`,
          ],
          note: "A silent retry contacts nobody, so it is exempt from quiet hours",
        }
      : {
          channel: "WHATSAPP",
          to: subject.contact,
          // Root cause deliberately dropped: the message may not claim a
          // diagnosis the agent could not make.
          lines: whatsappCopy({ ...copyContext(subject), rootCause: null }),
          link,
          note: `WhatsApp · payment link ${link} · the message claims no root cause`,
        },
    ifApproved: untouched
      ? "Boa runs the generic playbook for this case type: one silent retry, then the standard ladder inside the usual bounds."
      : `Boa spends attempt ${subject.attemptsUsed + 1} of ${
          subject.attemptCap
        } on a neutral nudge that claims no diagnosis, then stops.`,
    ifRejected:
      "The case is routed to manual review and closed to the agent. Boa writes no diagnosis it cannot stand behind.",
    resumeSteps: [
      {
        label: "Root cause confirmed",
        detail: "Recorded as a human decision, never as a model output",
      },
      {
        label: untouched ? "Retry executed" : "Nudge sent",
        detail: untouched ? "No customer contact" : "Neutral copy · no cause claimed",
      },
      {
        label: "Case resumed",
        detail: `Attempt ${subject.attemptsUsed + 1} of ${subject.attemptCap} · bounds unchanged`,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Over the value gate, or B2B → a person owns the account             */
/* ------------------------------------------------------------------ */

function b2bAsk(subject: AskSubject, pack: PolicyPack): Ask {
  const threshold = pack.escalation.valueThresholdPaise;
  const overThreshold = subject.amountPaise > threshold;
  const link = payLink(subject.caseId);
  const mail = emailCopy(copyContext(subject));

  return {
    headline: overThreshold
      ? `Work the ${money(subject.amountPaise)} receivable — over the ${money(threshold)} approval gate`
      : `Work the ${money(subject.amountPaise)} ${TYPE_NOUN[subject.type]} on a B2B account`,
    justification: [
      `${subject.customerName} is ${
        subject.attemptsUsed > 0
          ? `${subject.attemptsUsed} reminder${subject.attemptsUsed === 1 ? "" : "s"} in`
          : "unchased so far"
      } and the ${TYPE_NOUN[subject.type]} is still open. ${
        overThreshold
          ? `At ${money(subject.amountPaise)} it sits above the ${money(threshold)} gate, so the account is a person's to work rather than an agent's.`
          : `It is a B2B account, and a business relationship is not a nudge target.`
      }`,
      `The draft is a payment-terms email to the accounts inbox, written to be forwarded internally — which is how a receivable actually gets paid.`,
    ],
    chips: [
      overThreshold
        ? { label: `${money(subject.amountPaise)} > ${money(threshold)} gate`, tone: "waiting" }
        : { label: "B2B always → human", tone: "waiting" },
      { label: subject.segment === "B2B" ? "B2B account" : "B2C account" },
      { label: `${subject.attemptsUsed} of ${subject.attemptCap} attempts` },
      { label: "inside 09:00–21:00" },
    ],
    concessionPaise: 0,
    candidates: [],
    draft: {
      channel: "EMAIL",
      to: subject.contact,
      subject: mail.subject,
      lines: mail.lines,
      link,
      note: `Email to the accounts inbox · payment link ${link}`,
    },
    ifApproved: `Boa sends the email and books a follow-up inside the playbook at attempt ${
      subject.attemptsUsed + 1
    } of ${subject.attemptCap}.`,
    ifRejected: "The account stays with you. Boa makes no further contact on this receivable.",
    resumeSteps: [
      { label: "Policy re-check", detail: "Value gate cleared by a named human" },
      { label: "Email sent", detail: "Payment terms and a link to the accounts inbox" },
      { label: "Case resumed", detail: "Follow-up booked inside the playbook" },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Sitting with a person → carry on, or stand down                     */
/* ------------------------------------------------------------------ */

/**
 * The one ask that is not about a rule Boa tripped.
 *
 * The other four gates are questions the agent asks before acting. This one is
 * asked *after* the case stopped: somebody took it from the Control Tower, or
 * the agent escalated for a reason no gate covers — a promise that came and
 * went, a channel that would not deliver — and the case then sat in
 * `escalated` with nothing to answer. The queue read empty while three cases
 * waited on a person, which is the failure this gate exists to fix (D-151).
 *
 * So the question is the plain one: carry on, or stand down. A yes hands the
 * case back to Boa and sends the message below; a no closes it for good. And
 * when the attempt cap is already spent the card says so rather than promising
 * a send the gate will refuse — raising the cap is a policy edit, which belongs
 * in Policies where it is versioned (D-150).
 */
function handoverAsk(subject: AskSubject, pack: PolicyPack): Ask {
  const noun = TYPE_NOUN[subject.type];
  const link = payLink(subject.caseId);
  const capSpent = subject.attemptsUsed >= subject.attemptCap;
  const email = subject.channel === "EMAIL";
  const mail = email ? emailCopy(copyContext(subject)) : null;
  const quiet = `${clockLabel(pack.quiet.endMinutes)}–${clockLabel(pack.quiet.startMinutes)}`;

  return {
    headline: capSpent
      ? `Decide ${money(subject.amountPaise)}: the agent is out of attempts and the ${noun} is still open`
      : `Carry on chasing ${money(subject.amountPaise)}, or stand down`,
    justification: [
      subject.handoverReason
        ? `${subject.handoverReason}. Boa has stopped on this case and sent nothing since.`
        : `This case is being held by a person. Boa has stopped on it and will send nothing until somebody says otherwise.`,
      capSpent
        ? `${subject.attemptsUsed} of ${subject.attemptCap} attempts are spent, so a yes cannot send anything until the cap is raised in Policies. A no closes the case and leaves ${subject.customerName} alone.`
        : `A yes hands the case back and spends attempt ${subject.attemptsUsed + 1} of ${subject.attemptCap} on the message below, with the ladder carrying on from there. A no closes the case: no email, no WhatsApp, no call.`,
    ],
    chips: [
      { label: "held by a human", tone: "waiting" },
      {
        label: `${subject.attemptsUsed} of ${subject.attemptCap} attempts`,
        ...(capSpent ? { tone: "halted" } : {}),
      },
      ...(capSpent ? [{ label: "cap spent · raise it in Policies", tone: "halted" }] : []),
      { label: `${pack.contact.coolDownHours}h cool-down` },
      { label: `inside ${quiet}` },
    ],
    concessionPaise: 0,
    candidates: [],
    draft: {
      channel: email ? "EMAIL" : "WHATSAPP",
      to: subject.contact,
      ...(mail ? { subject: mail.subject } : {}),
      lines: mail ? mail.lines : whatsappCopy(copyContext(subject)),
      link,
      note: capSpent
        ? `Held back · the attempt cap is spent, so this sends only if the cap is raised first`
        : `${email ? "Email" : "WhatsApp"} · payment link ${link} · the next rung of this case's playbook`,
    },
    ifApproved: capSpent
      ? `Boa takes the case back, but the attempt cap still holds: nothing goes out until it is raised in Policies, and the case closes as exhausted if it is not.`
      : `Boa takes the case back and sends this at attempt ${subject.attemptsUsed + 1} of ${subject.attemptCap}. The gate runs again first, so quiet hours, the cool-down and an opt-out can still hold it.`,
    ifRejected: `Boa stands down for good: the case is halted, queued work is cancelled, and ${subject.customerName} is not contacted again.`,
    resumeSteps: [
      {
        label: "Case handed back",
        detail: "The hold is lifted and the pause on the ledger is appended over, not erased",
      },
      {
        label: capSpent ? "Send held" : "Message sent",
        detail: capSpent
          ? "The attempt cap refuses it at the gate until Policies says otherwise"
          : `${email ? "Email" : "WhatsApp"} · payment link ${link}`,
      },
      {
        label: "Ladder resumed",
        detail: capSpent
          ? "Nothing further is scheduled while the cap holds"
          : `Follow-up booked inside the playbook · ${pack.contact.coolDownHours}h cool-down starts now`,
      },
    ],
  };
}

/** 540 → "09:00", the way a policy bound is written on a card. */
function clockLabel(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  return `${String(hour).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
