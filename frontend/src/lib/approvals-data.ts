/**
 * Approvals Queue data (PRD 6.3, page 5) - the work the agent is not allowed
 * to do on its own.
 *
 * Shaped like `GET /approvals?status=pending` and the decision endpoints
 * (PRD 7.5), so wiring the real API in later means replacing the body of three
 * functions.
 *
 * Nothing here is invented beside the batch. A pending request is a case that
 * is *actually* sitting in `escalated` in the seeded pipeline, and the reason
 * it is here is the reason its own Case Detail page gives - both read
 * `approvalGateOf`. A history row is a case that has actually closed, and the
 * money on the row is that case's own recovered figure. Filter the pipeline to
 * `escalated` and count the rows: you get the number on this page's tab and on
 * the sidebar badge, because they are the same seven cases.
 *
 * Deterministic throughout: seeded PRNG keyed by case id, no clock, no
 * `Math.random`. Times are offsets from the batch anchor in `lib/clock`.
 *
 * Dependencies point one way - this module reads the pipeline and never the
 * Case Detail builder, which is what lets that builder import the decided set
 * from here and draw the approval onto the case's own timeline.
 */

import type { Tone } from "./dashboard-data";
import { DEMO_MERCHANT } from "./demo-merchant";
import { formatRupees } from "./money";
import {
  CASE_TYPE_META,
  ROOT_CAUSE_META,
  getPipelineCases,
  prefersHinglish,
  segmentOf,
  type CaseType,
  type PipelineCase,
  type RootCause,
  type Stage,
} from "./pipeline-data";

const RUPEE = 100;

/** The discount the planner asks for, in percent. Capped at 15 by policy v4. */
const DISCOUNT_PERCENT = 12;

/** Above this, a B2B receivable cannot be worked without a human (PRD 9.6). */
const B2B_GATE_PAISE = 25_000 * RUPEE;

/** Below this, a diagnosis is not trusted enough to act on (ADR-5). */
const CONFIDENCE_FLOOR = 0.6;

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * The four gates from PRD 9.6, and the whole reason this page exists: an
 * action that trips one of them is planned, checked and then *stopped* - it
 * never executes and asks forgiveness afterwards.
 */
export type ApprovalGate =
  | "discount_requires_approval"
  | "b2b_high_value"
  | "confidence_below_threshold"
  | "hardship_language";

export const GATE_META: Record<
  ApprovalGate,
  { label: string; rule: string; tone: Tone }
> = {
  discount_requires_approval: {
    label: "Discount",
    rule: "Any discount needs a human — there is no threshold under which Boa may give money away",
    tone: "waiting",
  },
  b2b_high_value: {
    label: "High-value B2B",
    rule: "Receivables over ₹25,000 are worked by a person, not by an agent",
    tone: "waiting",
  },
  confidence_below_threshold: {
    label: "Low confidence",
    rule: "Under 0.60 the diagnosis is not trusted, so Boa escalates instead of guessing",
    tone: "diagnosis",
  },
  hardship_language: {
    label: "Hardship",
    rule: "Dispute or hardship language stops the agent immediately and hands the case over",
    tone: "halted",
  },
};

export type PolicyChip = { label: string; tone?: Tone };

export type DraftChannel = "WHATSAPP" | "EMAIL" | "VOICE" | "RETRY";

/**
 * The exact thing that would leave the building.
 *
 * Not a summary of it - a summary is what an approver skims and then owns
 * without having read. This is the body, the recipient and the link, and it is
 * editable before it is approved.
 */
export type DraftMessage = {
  channel: DraftChannel;
  to: string;
  subject?: string;
  lines: string[];
  link?: string;
  /** What executing it actually does, in one line. */
  note: string;
};

/** What the case gains the moment a human says yes. */
export type ResumeStep = { label: string; detail: string };

export type ApprovalRequest = {
  id: string;
  caseId: string;
  gate: ApprovalGate;
  customer: string;
  segment: "B2C" | "B2B";
  caseType: CaseType;
  rootCause: RootCause;
  confidence: number | null;
  atRiskPaise: number;
  /** What approving costs the merchant. Zero unless the ask is a concession. */
  concessionPaise: number;
  /** One line: the action, what it costs, and the money it is chasing. */
  headline: string;
  /** Boa's case for it, in two lines, from the planner's LLM. */
  justification: string[];
  chips: PolicyChip[];
  draft: DraftMessage;
  /** Where the diagnosis got to - only when the gate is confidence. */
  candidates: { label: string; probability: number }[];
  attempts: number;
  attemptCap: number;
  contact: string;
  requestedMinutesAgo: number;
  ifApproved: string;
  ifRejected: string;
  resumeSteps: ResumeStep[];
};

/* ------------------------------------------------------------------ */
/* Deterministic helpers                                               */
/* ------------------------------------------------------------------ */

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFrom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)];
}

function between(low: number, high: number, rand: () => number): number {
  return Math.round(low + rand() * (high - low));
}

const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A Razorpay-shaped identifier, so a draft shows the id it would really use. */
function razorpayId(prefix: string, seed: string): string {
  let h = hash32(seed);
  let out = "";
  for (let i = 0; i < 14; i += 1) {
    h = Math.imul(h ^ (h >>> 13), 2246822507) >>> 0;
    out += BASE62[h % BASE62.length];
  }
  return `${prefix}_${out}`;
}

/** Whole rupees with the symbol. Money travels as paise everywhere else. */
function money(paise: number): string {
  return `₹${formatRupees(paise)}`;
}

/** "Beam Interiors" stays whole; "Aarav Gowda" is greeted as "Aarav". */
function greetingName(record: PipelineCase): string {
  return segmentOf(record) === "B2B" ? record.customer : record.customer.split(" ")[0];
}

const TYPE_NOUN: Record<CaseType, string> = {
  PAYMENT_FAILED: "payment",
  CHECKOUT_ABANDONED: "cart",
  MANDATE_FAILED: "subscription debit",
  INVOICE_OVERDUE: "invoice",
};

/* ------------------------------------------------------------------ */
/* Which gate stopped it                                               */
/* ------------------------------------------------------------------ */

/**
 * The one definition of why a case is waiting on a human.
 *
 * Exported because Case Detail names the same gate on the same case, and two
 * implementations of "why is this escalated" is two answers a panelist can
 * catch you between. Order matters: a case that could not be diagnosed is here
 * for that reason and no other, whatever else is true of it.
 */
export function approvalGateOf(record: PipelineCase): ApprovalGate {
  if (record.rootCause === "UNKNOWN") return "confidence_below_threshold";
  if (record.nextAction.toLowerCase().includes("hardship")) return "hardship_language";
  if (record.type === "INVOICE_OVERDUE" && record.amountPaise >= B2B_GATE_PAISE) {
    return "b2b_high_value";
  }
  return "discount_requires_approval";
}

/* ------------------------------------------------------------------ */
/* The ask                                                             */
/* ------------------------------------------------------------------ */

type Ask = {
  headline: string;
  justification: string[];
  chips: PolicyChip[];
  draft: DraftMessage;
  concessionPaise: number;
  candidates: { label: string; probability: number }[];
  ifApproved: string;
  ifRejected: string;
  resumeSteps: ResumeStep[];
};

function discountAsk(record: PipelineCase): Ask {
  const concession = Math.round((record.amountPaise * DISCOUNT_PERCENT) / 100);
  const net = record.amountPaise - concession;
  const name = greetingName(record);
  const hinglish = prefersHinglish(record);
  const noun = TYPE_NOUN[record.type];
  const link = razorpayId("plink", `${record.id}/discount`);

  return {
    headline: `Offer ${DISCOUNT_PERCENT}% off (${money(concession)}) to recover the ${money(
      record.amountPaise,
    )} ${noun}`,
    justification: [
      `${record.attempts} nudge${
        record.attempts === 1 ? "" : "s"
      } went unanswered and the last reply read as price-sensitive rather than uninterested — the customer asked what the final figure would be.`,
      `${DISCOUNT_PERCENT}% is inside the 15% margin cap and this customer has had no concession in 30 days, so this is the smallest ask that plausibly closes ${money(
        record.amountPaise,
      )}.`,
    ],
    chips: [
      { label: "any discount → human", tone: "waiting" },
      { label: `${DISCOUNT_PERCENT}% ≤ 15% cap` },
      { label: "1st concession · 30d" },
      { label: `${record.attempts} of ${record.attemptCap} attempts` },
      { label: "inside 09:00–21:00" },
    ],
    concessionPaise: concession,
    candidates: [],
    draft: {
      channel: "WHATSAPP",
      to: record.contact,
      lines: hinglish
        ? [
            `Namaste ${name} 👋 Aapka ${money(record.amountPaise)} ka ${noun} abhi bhi reserved hai.`,
            `Ek baar ke liye ${DISCOUNT_PERCENT}% off — ab sirf ${money(
              net,
            )} dena hoga. Link 24 ghante valid hai.`,
            `Messages band karne ke liye STOP likhein.`,
          ]
        : [
            `Hi ${name} — your ${noun} of ${money(record.amountPaise)} is still reserved.`,
            `Here is ${DISCOUNT_PERCENT}% off, one time: ${money(
              net,
            )} to complete it. The link is valid for 24 hours.`,
            `Reply STOP to stop these messages.`,
          ],
      link,
      note: `WhatsApp via the Twilio sandbox · payment link ${link} for ${money(net)}`,
    },
    ifApproved: `Boa re-runs the policy gate, sends this message, and reopens the case at attempt ${
      record.attempts + 1
    } of ${record.attemptCap}.`,
    ifRejected: `Boa stands down. No further contact is made and the ${noun} closes at its deadline with ${money(
      record.amountPaise,
    )} unrecovered.`,
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
        detail: `Attempt ${record.attempts + 1} of ${record.attemptCap} · 20h cool-down starts now`,
      },
    ],
  };
}

function hardshipAsk(record: PipelineCase, rand: () => number): Ask {
  const name = greetingName(record);
  const hinglish = prefersHinglish(record);
  const sentiment = -(0.55 + rand() * 0.3);
  // A plan is worth offering on real money; on a small basket the honest ask
  // is to close the case and leave the customer alone.
  const plan = record.amountPaise >= 1_000 * RUPEE;
  const instalment = Math.round(record.amountPaise / 3);
  const byEmail = plan && segmentOf(record) === "B2B";

  return {
    headline: plan
      ? `Pause 30 days and offer 3 × ${money(instalment)} on ${money(record.amountPaise)}`
      : `Close ${money(record.amountPaise)} with one acknowledgement and no further contact`,
    justification: [
      `The reply on this case carried hardship language and the classifier scored it ${sentiment.toFixed(
        2,
      )} — well inside the halt band. Boa stopped on the spot: nothing has gone out since.`,
      plan
        ? `A plan keeps the relationship and most of the money, where another reminder would recover neither. It needs a human because Boa may not offer terms on its own.`
        : `${money(
            record.amountPaise,
          )} does not justify a payment plan or a chase. The honest ask is to acknowledge, close, and stop.`,
    ],
    chips: [
      { label: "hardship → human", tone: "halted" },
      { label: "contact already halted", tone: "halted" },
      { label: `sentiment ${sentiment.toFixed(2)}` },
      { label: `${record.attempts} of ${record.attemptCap} attempts` },
      { label: "opt-out honoured" },
    ],
    concessionPaise: 0,
    candidates: [],
    draft: {
      channel: byEmail ? "EMAIL" : "WHATSAPP",
      to: record.contact,
      subject: byEmail ? `${record.customer} — settling this in three parts` : undefined,
      lines: plan
        ? hinglish
          ? [
              `${name}, aapka message mila — hum samajhte hain.`,
              `Agle 30 din tak koi reminder nahi jayega.`,
              `Aap chahein to ${money(instalment)} × 3 mahine ka plan le sakte hain, bina kisi extra charge ke.`,
              `Kuch bhi ho to yahin reply kar dijiye. STOP likhenge to hum ruk jayenge.`,
            ]
          : [
              `${name}, thank you for telling us — we understand.`,
              `We have paused all reminders on this account for 30 days.`,
              `If it helps, we can split it into three parts of ${money(
                instalment,
              )} at no extra cost.`,
              `Reply here any time, or STOP to hear nothing further.`,
            ]
        : hinglish
          ? [
              `${name}, aapka message mila. Hum aapko is baare mein dobara contact nahi karenge.`,
              `Order jab bhi ready ho, aap khud complete kar sakte hain. Dhanyavaad.`,
            ]
          : [
              `${name}, thank you for letting us know. We will not contact you about this again.`,
              `The order stays available if you ever want it. That is all from us.`,
            ],
      note: plan
        ? "One message, then a 30-day contact block enforced at the gate — not a reminder schedule"
        : "One acknowledgement, then the case closes and the customer is left alone",
    },
    ifApproved: plan
      ? "Boa sends this once, writes a 30-day contact block against the customer, and closes the case as handled."
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
        detail: plan
          ? "30-day contact block written against this customer"
          : "Closed as handled · no further contact",
      },
    ],
  };
}

const CANDIDATE_POOL: Record<CaseType, RootCause[]> = {
  PAYMENT_FAILED: ["BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS", "CARD_EXPIRED"],
  CHECKOUT_ABANDONED: ["CUSTOMER_DISTRACTED", "BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS"],
  MANDATE_FAILED: ["INSUFFICIENT_FUNDS", "MANDATE_REVOKED", "BANK_GATEWAY_DEGRADED"],
  INVOICE_OVERDUE: ["CUSTOMER_DISTRACTED", "INSUFFICIENT_FUNDS", "BANK_GATEWAY_DEGRADED"],
};

function confidenceAsk(record: PipelineCase, rand: () => number): Ask {
  const confidence = record.confidence ?? 0.4;
  const pool = CANDIDATE_POOL[record.type];
  const [first, second] = pool;
  const secondP = Math.max(0.08, Math.round((confidence - 0.06 - rand() * 0.12) * 100) / 100);
  const rest = Math.max(0.05, Math.round((1 - confidence - secondP) * 100) / 100);

  const untouched = record.attempts === 0;
  const errorCode = razorpayId("err", `${record.id}/code`).slice(4, 12).toUpperCase();
  const origin = razorpayId(record.type === "MANDATE_FAILED" ? "sub" : "pay", `${record.id}/origin`);
  const link = razorpayId("plink", `${record.id}/release`);
  const name = greetingName(record);
  const hinglish = prefersHinglish(record);

  return {
    headline: untouched
      ? `Confirm a root cause on ${money(record.amountPaise)} before anything is sent`
      : `Release one last attempt on ${money(record.amountPaise)} without a diagnosis`,
    justification: [
      `The gateway returned an unmapped reason code (${errorCode}) and the rules table has no entry for it. The model's best read is ${ROOT_CAUSE_META[
        first
      ].label.toLowerCase()} at ${confidence.toFixed(2)}, under the ${CONFIDENCE_FLOOR.toFixed(
        2,
      )} floor.`,
      untouched
        ? `Nothing has been sent on this case and nothing will be: under the floor Boa escalates rather than guesses, because a wrong diagnosis here sends the wrong message to a customer who did nothing wrong.`
        : `${record.attempts} attempts have run on the generic playbook without a diagnosis. Boa will not spend the last one on a guess, so the call is yours.`,
    ],
    chips: [
      {
        label: `confidence ${confidence.toFixed(2)} < ${CONFIDENCE_FLOOR.toFixed(2)}`,
        tone: "diagnosis",
      },
      { label: "no diagnosis written" },
      { label: `${record.attempts} of ${record.attemptCap} attempts` },
      { label: untouched ? "nothing sent yet" : "cool-down clear" },
    ],
    concessionPaise: 0,
    candidates: [
      { label: ROOT_CAUSE_META[first].label, probability: confidence },
      { label: ROOT_CAUSE_META[second].label, probability: secondP },
      { label: "Unmapped — needs a human", probability: rest },
    ],
    draft: untouched
      ? {
          channel: "RETRY",
          to: origin,
          lines: [
            `POST /v1/payments/${origin}/retry`,
            `{ "amount": ${record.amountPaise}, "currency": "INR", "idempotency_key": "${record.id}-retry-1" }`,
            `No customer contact. If it fails again, Boa stops and comes back here.`,
          ],
          note: "Razorpay test mode · a silent retry contacts nobody, so it is exempt from quiet hours",
        }
      : {
          channel: "WHATSAPP",
          to: record.contact,
          lines: hinglish
            ? [
                `Namaste ${name} 👋 Aapka ${money(record.amountPaise)} ka payment complete nahi hua.`,
                `Yeh raha ek naya link — dobara charge nahi hoga.`,
                `Messages band karne ke liye STOP likhein.`,
              ]
            : [
                `Hi ${name} — your payment of ${money(record.amountPaise)} did not go through.`,
                `Here is a fresh link. You will not be charged twice.`,
                `Reply STOP to stop these messages.`,
              ],
          link,
          note: `WhatsApp via the Twilio sandbox · payment link ${link} · the message claims no root cause`,
        },
    ifApproved: untouched
      ? "Boa runs the generic payment-failure playbook: one silent retry, then the standard ladder inside the usual bounds."
      : `Boa spends attempt ${record.attempts + 1} of ${
          record.attemptCap
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
        detail: untouched ? "Razorpay test mode · no customer contact" : "Neutral copy · no cause claimed",
      },
      {
        label: "Case resumed",
        detail: `Attempt ${record.attempts + 1} of ${record.attemptCap} · bounds unchanged`,
      },
    ],
  };
}

function b2bAsk(record: PipelineCase, rand: () => number): Ask {
  const reference = `INV-${between(1_000, 9_800, rand)}`;
  const link = razorpayId("plink", `${record.id}/b2b`);

  return {
    headline: `Work the ${money(record.amountPaise)} receivable — over the ${money(
      B2B_GATE_PAISE,
    )} B2B gate`,
    justification: [
      `${record.customer} is ${
        record.attempts > 0 ? `${record.attempts} reminders in` : "unchased so far"
      } and the invoice is past due. At ${money(
        record.amountPaise,
      )} it sits above the B2B gate, so the account is a person's to work rather than an agent's.`,
      `The draft is a payment-terms email to the accounts inbox, written to be forwarded internally — which is how a receivable actually gets paid.`,
    ],
    chips: [
      { label: `${money(record.amountPaise)} > ${money(B2B_GATE_PAISE)} gate`, tone: "waiting" },
      { label: "B2B account" },
      { label: `${record.attempts} of ${record.attemptCap} attempts` },
      { label: "inside 09:00–21:00" },
    ],
    concessionPaise: 0,
    candidates: [],
    draft: {
      channel: "EMAIL",
      to: record.contact,
      subject: `${reference} · ${money(record.amountPaise)} outstanding — payment link inside`,
      lines: [
        `Hello,`,
        `${reference} for ${money(
          record.amountPaise,
        )} is past its due date. The link below settles it in one click and issues the receipt automatically.`,
        `If it is already scheduled, reply with the date and we will close our end.`,
      ],
      link,
      note: `Resend · a real email to the accounts inbox · payment link ${link}`,
    },
    ifApproved: `Boa sends the email and books a follow-up inside the receivables playbook at attempt ${
      record.attempts + 1
    } of ${record.attemptCap}.`,
    ifRejected: "The account stays with you. Boa makes no further contact on this receivable.",
    resumeSteps: [
      { label: "Policy re-check", detail: "B2B gate cleared by a named human" },
      { label: "Email sent", detail: "Resend · payment terms and a link to the accounts inbox" },
      { label: "Case resumed", detail: "Follow-up booked inside the receivables playbook" },
    ],
  };
}

function askFor(record: PipelineCase, gate: ApprovalGate, rand: () => number): Ask {
  switch (gate) {
    case "discount_requires_approval":
      return discountAsk(record);
    case "hardship_language":
      return hardshipAsk(record, rand);
    case "b2b_high_value":
      return b2bAsk(record, rand);
    default:
      return confidenceAsk(record, rand);
  }
}

/* ------------------------------------------------------------------ */
/* GET /approvals?status=pending                                       */
/* ------------------------------------------------------------------ */

function buildRequest(
  record: PipelineCase,
  overrides?: { gate?: ApprovalGate; requestedMinutesAgo?: number },
): ApprovalRequest {
  const gate = overrides?.gate ?? approvalGateOf(record);
  const rand = rngFrom(hash32(`tugboat/approval/${record.id}/${gate}`));
  const ask = askFor(record, gate, rand);

  return {
    // The request carries its case's number: an approver reading a toast should
    // not have to translate an id before they know which case moved.
    id: `AP-${record.id.replace(/^C-/, "")}`,
    caseId: record.id,
    gate,
    customer: record.customer,
    segment: segmentOf(record),
    caseType: record.type,
    rootCause: record.rootCause,
    confidence: record.confidence,
    atRiskPaise: record.amountPaise,
    concessionPaise: ask.concessionPaise,
    headline: ask.headline,
    justification: ask.justification,
    chips: ask.chips,
    draft: ask.draft,
    candidates: ask.candidates,
    attempts: record.attempts,
    attemptCap: record.attemptCap,
    contact: record.contact,
    requestedMinutesAgo: overrides?.requestedMinutesAgo ?? record.updatedMinutesAgo,
    ifApproved: ask.ifApproved,
    ifRejected: ask.ifRejected,
    resumeSteps: ask.resumeSteps,
  };
}

let pendingCache: ApprovalRequest[] | null = null;

/**
 * Everything waiting on a human, which is exactly the pipeline's `escalated`
 * cases and nothing else.
 *
 * Sorted by money at risk. A queue ordered by arrival is fair to requests; a
 * revenue product should be fair to the revenue - and the wait clock on every
 * card keeps the ageing ones visible anyway.
 */
export function getPendingApprovals(): ApprovalRequest[] {
  if (pendingCache) return pendingCache;

  pendingCache = getPipelineCases()
    .filter((record) => record.stage === "escalated")
    .map((record) => buildRequest(record))
    .sort((a, b) => b.atRiskPaise - a.atRiskPaise);

  return pendingCache;
}

/** The count on the sidebar badge, without building the cards to get it. */
export function getPendingApprovalCount(): number {
  return getPendingApprovals().length;
}

/**
 * The escalation that lands while the page is open.
 *
 * The same case the Control Tower's activity feed escalates on the same
 * grounds (entry `s-11`), so a panelist who watched the dashboard and then
 * opened this page sees one event rather than two coincidences. Stands in for
 * the `approval.pending` Socket.IO event.
 */
export function getLiveEscalation(): ApprovalRequest | null {
  const record = getPipelineCases().find((row) => row.id === "C-1188");
  if (!record) return null;

  const request = buildRequest(record, {
    gate: "hardship_language",
    requestedMinutesAgo: 0,
  });

  return {
    ...request,
    justification: [
      `A reply landed moments ago carrying hardship language, and the classifier scored it −0.71. Boa halted every scheduled action on this case before writing this request.`,
      `The silent retry queued for 18:25 was cancelled, not deferred. Nothing further goes out on this case without your decision.`,
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Decisions already taken                                             */
/* ------------------------------------------------------------------ */

export type DecidedApproval = {
  id: string;
  caseId: string;
  gate: ApprovalGate;
  decision: "approved" | "rejected";
  decidedBy: string;
  /** The attempt the case was on when the gate stopped it. */
  afterAttempt: number;
  headline: string;
  /** Rejections carry one; an approval does not need one. */
  reason: string | null;
  requestedMinutesAgo: number;
  decidedMinutesAgo: number;
  latencySeconds: number;
};

/**
 * Response times, as a ladder rather than a distribution.
 *
 * Fifteen values whose median is the 22 seconds the demo quotes, with a tail
 * that is honest about the two requests which sat for minutes. The page never
 * prints 22: it computes the median from these rows and prints that, so the
 * KPI cannot drift away from the table underneath it.
 */
const LATENCY_LADDER = [7, 9, 11, 14, 16, 19, 21, 22, 26, 33, 41, 58, 74, 118, 186];

/**
 * Why a merchant says no, per gate.
 *
 * Gate-specific because a generic list produces nonsense: "margin is already
 * thin" is not a reason to refuse a hardship stand-down, and an approver
 * offered it would stop reading the options. Shared with the reject dialog so
 * the reasons in the history table are the reasons the dialog can actually
 * produce.
 */
const REJECTION_REASONS: Record<ApprovalGate, string[]> = {
  discount_requires_approval: [
    "Margin is already thin on this line — no discount",
    "This account took a concession last quarter",
    "The amount does not justify giving anything away",
    "Chase it once more, but without a discount",
  ],
  b2b_high_value: [
    "Sales owns this account — they will handle it",
    "Payment is already scheduled · do not chase",
    "This one goes out from our inbox, not the agent's",
  ],
  confidence_below_threshold: [
    "Route to manual review rather than another automated attempt",
    "The guess is wrong — this is not what failed",
    "Too small to spend another attempt on",
  ],
  hardship_language: [
    "No payment plan on this account — close it instead",
    "Collections will take this one from here",
    "The terms are wrong · I will make the offer myself",
  ],
};

/** The reasons the reject dialog offers for a given gate. */
export function rejectionReasonsFor(gate: ApprovalGate): string[] {
  return REJECTION_REASONS[gate];
}

/**
 * The gate a closed case was stopped by.
 *
 * A history row is a real case, so its gate has to be one that case could
 * plausibly have tripped: an undiagnosable case tripped the confidence floor,
 * a large receivable tripped the B2B gate, and most of the rest were stopped
 * for asking to give money away - which is the gate that fires most in
 * practice.
 */
function historyGateOf(
  record: PipelineCase,
  decision: "approved" | "rejected",
  rand: () => number,
): ApprovalGate {
  if (record.rootCause === "UNKNOWN") return "confidence_below_threshold";
  if (record.type === "INVOICE_OVERDUE" && record.amountPaise >= B2B_GATE_PAISE) {
    return "b2b_high_value";
  }
  // Hardship only where it fits what the case then did: a customer who said
  // they could not pay is not a customer who paid a fortnight later, and a
  // request to stand down is not one a merchant refuses.
  if (decision === "approved" && record.stage !== "recovered" && rand() < 0.5) {
    return "hardship_language";
  }
  return "discount_requires_approval";
}

/** Seeded pick order, so the same cases are drawn on every render. */
function shuffled(records: PipelineCase[], seed: string): PipelineCase[] {
  return records
    .map((record) => ({ record, key: hash32(`${seed}/${record.id}`) }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.record);
}

let decidedCache: DecidedApproval[] | null = null;

/**
 * The decisions this merchant has already taken.
 *
 * Drawn from cases that have actually closed, and each decision has to fit
 * what its case then did: a rejected concession is followed by the case
 * exhausting its remaining attempts without one, which is exactly what those
 * timelines show. Approvals mostly precede a recovery - and two of them do
 * not, because an approvals page on which every yes worked is a page nobody
 * believes.
 */
export function getDecidedApprovals(): DecidedApproval[] {
  if (decidedCache) return decidedCache;

  const cases = getPipelineCases();
  const recovered = shuffled(
    cases.filter((row) => row.stage === "recovered" && row.attempts >= 2),
    "approvals/recovered",
  ).slice(0, 9);
  // Sorted by value inside the closed pool so the yeses that failed are not
  // quietly the three smallest: a post-approval recovery rate computed only
  // over cheap failures is a flattering number, and this page does not want
  // one.
  const closed = shuffled(
    cases.filter((row) => row.stage === "exhausted" && row.attempts >= 2),
    "approvals/closed",
  )
    .slice(0, 6)
    .sort((a, b) => b.amountPaise - a.amountPaise);

  const chosen: { record: PipelineCase; decision: "approved" | "rejected" }[] = [
    ...recovered.map((record) => ({ record, decision: "approved" as const })),
    // Three yeses that did not work, three noes. Both are the page's honesty.
    ...closed.map((record, i) => ({
      record,
      decision: (i < 3 ? "approved" : "rejected") as "approved" | "rejected",
    })),
  ];

  const decided = chosen.map(({ record, decision }, index) => {
    const rand = rngFrom(hash32(`tugboat/decided/${record.id}`));
    const gate = historyGateOf(record, decision, rand);
    const ask = askFor(record, gate, rngFrom(hash32(`tugboat/approval/${record.id}/${gate}`)));
    const latencySeconds = LATENCY_LADDER[index % LATENCY_LADDER.length];
    // The request was raised before the case closed, not after it.
    const requestedMinutesAgo = record.updatedMinutesAgo + between(45, 900, rand);

    return {
      id: `AP-${record.id.replace(/^C-/, "")}`,
      caseId: record.id,
      gate,
      decision,
      decidedBy: DEMO_MERCHANT.displayName,
      afterAttempt: Math.max(1, record.attempts - 1),
      headline: ask.headline,
      reason: decision === "rejected" ? pick(REJECTION_REASONS[gate], rand) : null,
      requestedMinutesAgo,
      decidedMinutesAgo: requestedMinutesAgo - latencySeconds / 60,
      latencySeconds,
    };
  });

  // Newest decision first: the reading order of a log.
  decidedCache = decided.sort((a, b) => a.decidedMinutesAgo - b.decidedMinutesAgo);
  return decidedCache;
}

const decidedIndex = new Map<string, DecidedApproval>();

/**
 * The decision taken on one case, if there was one.
 *
 * Read by the Case Detail builder so the approval appears as a node on that
 * case's own timeline. Without it this page would be claiming a decision the
 * case's ledger had never heard of - and the ledger is the thing that is
 * supposed to be true.
 */
export function decidedApprovalFor(caseId: string): DecidedApproval | null {
  if (decidedIndex.size === 0) {
    for (const entry of getDecidedApprovals()) decidedIndex.set(entry.caseId, entry);
  }
  return decidedIndex.get(caseId) ?? null;
}

/* ------------------------------------------------------------------ */
/* History rows                                                        */
/* ------------------------------------------------------------------ */

export type ApprovalHistoryRow = DecidedApproval & {
  customer: string;
  caseType: CaseType;
  stage: Stage;
  atRiskPaise: number;
  recoveredPaise: number;
  concessionPaise: number;
  /** What happened to the money afterwards, in the case's own figures. */
  outcome: string;
};

export function getApprovalHistory(): ApprovalHistoryRow[] {
  const byId = new Map(getPipelineCases().map((row) => [row.id, row]));

  return getDecidedApprovals().flatMap((entry) => {
    const record = byId.get(entry.caseId);
    if (!record) return [];

    const concession =
      entry.decision === "approved" && entry.gate === "discount_requires_approval"
        ? Math.round((record.amountPaise * DISCOUNT_PERCENT) / 100)
        : 0;

    const outcome =
      record.stage === "recovered"
        ? `Recovered ${money(record.recoveredPaise)} · ${record.attempts}/${record.attemptCap}`
        : entry.decision === "rejected"
          ? "Not recovered · closed at the cap"
          : "Not recovered · the action did not land";

    return [
      {
        ...entry,
        customer: record.customer,
        caseType: record.type,
        stage: record.stage,
        atRiskPaise: record.amountPaise,
        recoveredPaise: record.recoveredPaise,
        concessionPaise: concession,
        outcome,
      },
    ];
  });
}

/* ------------------------------------------------------------------ */
/* GET /approvals/stats                                                */
/* ------------------------------------------------------------------ */

export type ApprovalStats = {
  pending: number;
  pendingValuePaise: number;
  oldestWaitMinutes: number;
  decisions: number;
  approved: number;
  rejected: number;
  approvalRate: number;
  medianLatencySeconds: number;
  slowestLatencySeconds: number;
  releasedValuePaise: number;
  recoveredAfterApprovalPaise: number;
  recoveredAfterApprovalCases: number;
  /** Of the value a yes released, how much actually came back. */
  postApprovalRecoveryRate: number;
  concessionPaise: number;
};

export function getApprovalStats(): ApprovalStats {
  const pending = getPendingApprovals();
  const history = getApprovalHistory();

  const approved = history.filter((row) => row.decision === "approved");
  const latencies = history.map((row) => row.latencySeconds).sort((a, b) => a - b);
  const median =
    latencies.length === 0
      ? 0
      : latencies.length % 2 === 1
        ? latencies[(latencies.length - 1) / 2]
        : Math.round((latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2);

  const releasedPaise = approved.reduce((sum, row) => sum + row.atRiskPaise, 0);
  const recoveredPaise = approved.reduce((sum, row) => sum + row.recoveredPaise, 0);

  return {
    pending: pending.length,
    pendingValuePaise: pending.reduce((sum, row) => sum + row.atRiskPaise, 0),
    oldestWaitMinutes: pending.reduce((max, row) => Math.max(max, row.requestedMinutesAgo), 0),
    decisions: history.length,
    approved: approved.length,
    rejected: history.length - approved.length,
    approvalRate: history.length === 0 ? 0 : approved.length / history.length,
    medianLatencySeconds: median,
    slowestLatencySeconds: latencies[latencies.length - 1] ?? 0,
    releasedValuePaise: releasedPaise,
    recoveredAfterApprovalPaise: recoveredPaise,
    recoveredAfterApprovalCases: approved.filter((row) => row.recoveredPaise > 0).length,
    postApprovalRecoveryRate: releasedPaise === 0 ? 0 : recoveredPaise / releasedPaise,
    concessionPaise: history.reduce((sum, row) => sum + row.concessionPaise, 0),
  };
}

export { CASE_TYPE_META, ROOT_CAUSE_META };
