/**
 * Case Detail data (PRD 6.3, page 4) - the full replayable story of one case.
 *
 * Shaped like `GET /cases/:id` (PRD 7.5), which returns the case plus its
 * events, actions and audit rows. The timeline UI renders the event log
 * directly (ADR-3), so there is exactly one account of what happened and no
 * way for "what the agent did" and "what the screen says" to drift apart.
 *
 * Every case in the seeded batch resolves here - all 214, not a handful of
 * hand-written ones - because the Pipeline links every row to this page and a
 * story that only exists for the demo cases is a story a panelist can catch
 * you out on. The narrative is derived from the facts the Pipeline already
 * publishes about the case (type, root cause, method, confidence, attempts,
 * stage, amount, age), so it cannot contradict the list it was opened from.
 *
 * Deterministic throughout: seeded PRNG keyed by case id, no clock, no
 * `Math.random`. The clock is a fixed anchor rather than `Date.now()` for the
 * same reason the Pipeline stores ages as offsets - a timestamp computed at
 * render time is a hydration mismatch on every load.
 */

import {
  GATE_META,
  approvalGateOf,
  decidedApprovalFor,
  type DecidedApproval,
} from "./approvals-data";
import { formatLatency, formatSpan, stampOf } from "./clock";
import type { Tone } from "./dashboard-data";
import { DEMO_MERCHANT } from "./demo-merchant";
import { ledgerDigest } from "./ledger-digest";
import {
  CASE_TYPE_META,
  ROOT_CAUSE_META,
  STAGE_META,
  getPipelineCases,
  prefersHinglish,
  segmentOf,
  type CaseType,
  type PipelineCase,
  type RootCause,
  type Stage,
} from "./pipeline-data";

/* ------------------------------------------------------------------ */
/* The batch clock                                                     */
/* ------------------------------------------------------------------ */

/**
 * The clock lives in `lib/clock` and is re-exported here.
 *
 * Every page that stamps an event measures back from the same anchor, so the
 * Case Detail timeline, the Approvals Queue and the ledger can never disagree
 * about when something happened. Callers that already import `stampOf` from
 * this module keep working - the anchor simply stopped being this module's
 * private property once a second page needed it.
 */
export { CLOCK_ANCHOR_LABEL, formatSpan, stampOf } from "./clock";
export type { Stamp } from "./clock";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export type Channel = "RETRY" | "WHATSAPP" | "EMAIL" | "VOICE";

export const CHANNEL_META: Record<Channel, { label: string; short: string; mode: string }> = {
  RETRY: { label: "Razorpay retry", short: "Retry", mode: "Razorpay test mode · real endpoint" },
  WHATSAPP: { label: "WhatsApp", short: "WhatsApp", mode: "Twilio sandbox · real message" },
  EMAIL: { label: "Email", short: "Email", mode: "Resend · real message" },
  VOICE: { label: "Voice call", short: "Voice", mode: "Simulated telephony · labelled" },
};

export type EventKind =
  | "DETECTED"
  | "DIAGNOSED"
  | "PLANNED"
  | "POLICY_CHECK"
  | "EMAIL_SENT"
  | "WHATSAPP_SENT"
  | "VOICE_CALL"
  | "RETRY_EXECUTED"
  | "CUSTOMER_REPLY"
  | "PROMISE_RECORDED"
  | "ESCALATED"
  | "APPROVAL_DECIDED"
  | "HALTED"
  | "RECOVERED";

export type Sentiment = "positive" | "neutral" | "negative" | "opt-out";

export type FactRow = { label: string; value: string; mono?: boolean; tone?: Tone };

export type PolicyCheck = { name: string; verdict: "pass" | "block" | "skip"; note: string };

export type Turn = { speaker: "BOA" | "CUSTOMER"; text: string };

export type EventBody =
  | { type: "facts"; rows: FactRow[] }
  | { type: "diagnosis"; reasoning: string[]; rows: FactRow[] }
  | {
      type: "plan";
      chosen: string;
      because: string;
      rejected: { option: string; reason: string }[];
    }
  | { type: "policy"; checks: PolicyCheck[]; rows: FactRow[] }
  | {
      type: "message";
      channel: "EMAIL" | "WHATSAPP";
      subject?: string;
      lines: string[];
      link?: string;
      rows: FactRow[];
    }
  | {
      type: "voice";
      seconds: number;
      transcript: Turn[];
      summary: string;
      intent: string;
      rows: FactRow[];
    }
  | { type: "reply"; channel: Channel; text: string; sentiment: Sentiment; rows: FactRow[] }
  | { type: "promise"; amountPaise: number; dateLabel: string; daysAway: number; rows: FactRow[] };

export type CaseEvent = {
  id: string;
  seq: number;
  kind: EventKind;
  /** Minutes before the batch clock anchor. Pending events carry 0. */
  minutesAgo: number;
  title: string;
  summary: string;
  badge?: { label: string; tone: Tone };
  body?: EventBody;
};

export type AuditEntry = {
  seq: number;
  hash: string;
  prevHash: string;
  actor: "BOA" | "POLICY" | "SYSTEM" | "HUMAN";
  action: string;
  minutesAgo: number;
  detail: string;
};

export type CustomerProfile = {
  name: string;
  phone: string;
  email: string;
  language: string;
  languageNote: string;
  timezone: string;
  segment: "B2C" | "B2B";
  history: string;
};

export type OriginObject = {
  kind: string;
  id: string;
  href: string;
  reference: string;
};

export type Bounds = {
  attemptsUsed: number;
  attemptCap: number;
  channels: { channel: Channel; used: number; cap: number }[];
  quietHours: string;
  quietNote: string;
  optedOut: boolean;
  optOutNote: string;
  coolDownMinutesLeft: number | null;
  coolDownNote: string;
  deadlineNote: string;
  policyVersion: string;
  /**
   * The case has stopped. Every other number here still reports what it
   * measured, but none of them will ever be spent - a halted case advertising
   * "2 attempts left" would describe rope the gate has already cut.
   */
  closed: boolean;
  /** What ended it, in the panel's own words. */
  closedNote: string | null;
};

export type Outcome = {
  stage: Stage;
  headline: string;
  detail: string;
  atRiskPaise: number;
  recoveredPaise: number;
  timeToRecoveryMinutes: number | null;
  contacts: number;
  llmCalls: number;
  llmTokens: number;
  /** What the run actually cost on the free tiers - which is nothing. */
  spentPaise: number;
  /** What the same run would cost at production prices (PRD 5.5). */
  projectedLlmPaise: number;
  projectedChannelPaise: number;
};

export type CaseDetail = {
  record: PipelineCase;
  customer: CustomerProfile;
  origin: OriginObject;
  openedMinutesAgo: number;
  deadlineLabel: string;
  bounds: Bounds;
  events: CaseEvent[];
  /** Scheduled, not yet executed - the timeline reveals these live. */
  pending: CaseEvent[];
  outcome: Outcome;
  audit: AuditEntry[];
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

/** A Razorpay-shaped identifier: 14 base62 characters behind a type prefix. */
function razorpayId(prefix: string, seed: string): string {
  let h = hash32(seed);
  let out = "";
  for (let i = 0; i < 14; i += 1) {
    h = Math.imul(h ^ (h >>> 13), 2246822507) >>> 0;
    out += BASE62[h % BASE62.length];
  }
  return `${prefix}_${out}`;
}

/**
 * The ledger digest, from the one module that defines it. Kept as a local
 * alias because every call site here reads `hex(seed, 10)`, and the Audit
 * Explorer has to be able to recompute exactly what those calls produced.
 */
const hex = ledgerDigest;

/** Whole rupees with Indian grouping. No symbol - callers add it. */
export function inr(paise: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    Math.round(paise / 100),
  );
}

/** Sub-rupee precision, for the cost figures. */
export function paiseText(paise: number): string {
  return `₹${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100)}`;
}

/** "24 Aug", from an offset in minutes before the anchor. */
function dayLabel(minutesAgo: number): string {
  return stampOf(minutesAgo).day;
}

/* ------------------------------------------------------------------ */
/* Case facts                                                          */
/* ------------------------------------------------------------------ */

const ORIGIN_KIND: Record<CaseType, { kind: string; prefix: string; path: string }> = {
  PAYMENT_FAILED: { kind: "Razorpay payment", prefix: "pay", path: "payments" },
  CHECKOUT_ABANDONED: { kind: "Razorpay order", prefix: "order", path: "orders" },
  MANDATE_FAILED: { kind: "Razorpay subscription", prefix: "sub", path: "subscriptions" },
  INVOICE_OVERDUE: { kind: "Razorpay invoice", prefix: "inv", path: "invoices" },
};

function buildOrigin(record: PipelineCase, rand: () => number): OriginObject {
  const meta = ORIGIN_KIND[record.type];
  const id = razorpayId(meta.prefix, `${record.id}/origin`);
  const reference =
    record.type === "INVOICE_OVERDUE"
      ? `INV-${String(between(1000, 9800, rand))}`
      : record.type === "MANDATE_FAILED"
        ? `Cycle ${between(3, 19, rand)} · monthly`
        : `Receipt rcpt-${hex(`${record.id}/rcpt`, 6)}`;

  return {
    kind: meta.kind,
    id,
    href: `https://dashboard.razorpay.com/app/${meta.path}/${id}`,
    reference,
  };
}

/**
 * The customer, masked at the source.
 *
 * Language preference is a real field on the case rather than decoration: it
 * decides which script the voice call and the nudges are written in, and the
 * PII rule (PRD 9.9) means the model only ever sees what is on this card.
 */
function buildCustomer(record: PipelineCase, rand: () => number): CustomerProfile {
  // Segment and language are shared with the Approvals Queue, which renders the
  // draft this customer would actually receive - so neither is drawn from this
  // module's random stream.
  const segment = segmentOf(record);
  const hinglish = prefersHinglish(record);
  const phone = record.contact.includes("@")
    ? `${pick(["70", "88", "93", "96", "98"], rand)}•••••${String(between(100, 999, rand))}`
    : record.contact;
  const email = record.contact.includes("@")
    ? record.contact
    : `${record.customer.slice(0, 1).toLowerCase()}•••••@${pick(
        ["gmail.com", "outlook.com", "yahoo.in"],
        rand,
      )}`;

  const priorCases = between(0, 4, rand);

  return {
    name: record.customer,
    phone,
    email,
    language: hinglish ? "hi-IN · Hinglish" : "en-IN · English",
    languageNote: hinglish
      ? "Nudges and the voice script are written code-mixed"
      : "Nudges and the voice script are written in English",
    timezone: "Asia/Kolkata · IST",
    segment,
    history:
      priorCases === 0
        ? "First case for this customer"
        : `${priorCases} earlier case${priorCases === 1 ? "" : "s"} · recovered`,
  };
}

function isHinglish(customer: CustomerProfile): boolean {
  return customer.language.startsWith("hi-IN");
}

/* ------------------------------------------------------------------ */
/* Detection signals                                                   */
/* ------------------------------------------------------------------ */

const GATEWAY_ERROR: Record<RootCause, { code: string; reason: string; source: string }> = {
  BANK_GATEWAY_DEGRADED: {
    code: "GATEWAY_ERROR",
    reason: "payment_upi_collect_timeout",
    source: "Bank",
  },
  INSUFFICIENT_FUNDS: {
    code: "BAD_REQUEST_ERROR",
    reason: "payment_failed_insufficient_funds",
    source: "Bank",
  },
  CARD_EXPIRED: {
    code: "BAD_REQUEST_ERROR",
    reason: "payment_card_expired",
    source: "Issuer",
  },
  MANDATE_REVOKED: {
    code: "BAD_REQUEST_ERROR",
    reason: "mandate_revoked_by_customer",
    source: "Bank",
  },
  CUSTOMER_DISTRACTED: {
    code: "—",
    reason: "no_gateway_error",
    source: "Checkout",
  },
  UNKNOWN: {
    code: "SERVER_ERROR",
    reason: "payment_failed_unknown_reason",
    source: "Gateway",
  },
};

const BANKS = ["HDFC", "ICICI", "SBI", "Axis", "Kotak", "IndusInd"] as const;

const INSTRUMENTS: Record<CaseType, readonly string[]> = {
  PAYMENT_FAILED: ["UPI collect", "UPI intent", "Card · Visa debit", "Net banking"],
  CHECKOUT_ABANDONED: ["UPI intent", "Card · Mastercard credit", "Net banking"],
  MANDATE_FAILED: ["UPI AutoPay", "e-NACH · debit"],
  INVOICE_OVERDUE: ["Bank transfer", "UPI collect"],
};

function signalLabel(record: PipelineCase): string {
  switch (record.type) {
    case "PAYMENT_FAILED":
      return "Payment failed";
    case "CHECKOUT_ABANDONED":
      return "Checkout abandoned";
    case "MANDATE_FAILED":
      return "Mandate debit failed";
    default:
      return "Invoice past due";
  }
}

/* ------------------------------------------------------------------ */
/* Channel plan                                                        */
/* ------------------------------------------------------------------ */

const LADDER: Record<RootCause, Channel[]> = {
  BANK_GATEWAY_DEGRADED: ["RETRY", "RETRY", "WHATSAPP", "EMAIL"],
  INSUFFICIENT_FUNDS: ["WHATSAPP", "RETRY", "VOICE", "EMAIL"],
  CARD_EXPIRED: ["WHATSAPP", "EMAIL", "VOICE", "WHATSAPP"],
  CUSTOMER_DISTRACTED: ["EMAIL", "WHATSAPP", "VOICE", "EMAIL"],
  MANDATE_REVOKED: ["EMAIL", "WHATSAPP", "VOICE", "EMAIL"],
  UNKNOWN: ["EMAIL", "WHATSAPP", "EMAIL", "EMAIL"],
};

/**
 * Which channel each attempt uses, from the playbooks (PRD 7.6).
 *
 * Cheapest first is a rule rather than a preference: a silent retry costs
 * nothing and asks nothing of the customer, so it goes ahead of every message
 * that does. Voice never appears before the third attempt and never twice -
 * there is a per-channel cap of one on it (PRD 9.2).
 */
function channelPlan(record: PipelineCase, attempts: number): Channel[] {
  let ladder = LADDER[record.rootCause];

  if (record.type === "MANDATE_FAILED") {
    ladder =
      record.rootCause === "MANDATE_REVOKED"
        ? ["EMAIL", "WHATSAPP", "VOICE", "EMAIL"]
        : ["RETRY", "WHATSAPP", "RETRY", "VOICE"];
  } else if (record.type === "INVOICE_OVERDUE") {
    ladder = ["EMAIL", "EMAIL", "VOICE", "WHATSAPP"];
  } else if (record.type === "CHECKOUT_ABANDONED" && record.rootCause !== "BANK_GATEWAY_DEGRADED") {
    ladder = ["WHATSAPP", "EMAIL", "VOICE", "WHATSAPP"];
  }

  const plan = ladder.slice(0, attempts);

  // A promise comes out of a conversation, so the last contact has to be one.
  if (record.stage === "promised" && plan.length > 0 && !plan.includes("VOICE")) {
    plan[plan.length - 1] = "VOICE";
  }

  let voiceSeen = false;
  return plan.map((channel) => {
    if (channel !== "VOICE") return channel;
    if (voiceSeen) return "WHATSAPP";
    voiceSeen = true;
    return channel;
  });
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

const MERCHANT = DEMO_MERCHANT.displayName;

function firstName(name: string): string {
  return name.split(" ")[0];
}

function payLink(record: PipelineCase): string {
  return `rzp.io/l/tug-${hex(`${record.id}/link`, 6)}`;
}

function whatsappCopy(record: PipelineCase, customer: CustomerProfile, attempt: number): string[] {
  const amount = `₹${inr(record.amountPaise)}`;
  const who = firstName(customer.name);
  const link = payLink(record);
  const optOut = "Reply STOP if you'd rather not hear from us.";

  if (isHinglish(customer)) {
    switch (record.rootCause) {
      case "INSUFFICIENT_FUNDS":
        return [
          `Namaste ${who}, ${MERCHANT} se Boa bol rahi hoon.`,
          `Aapka ${amount} ka payment complete nahi ho paaya — bank ne balance short bataya.`,
          `Jab convenient ho, is link se pura kar dijiye: ${link}`,
          optOut,
        ];
      case "CARD_EXPIRED":
        return [
          `Namaste ${who}, ${MERCHANT} se Boa.`,
          `Aapke card ki validity khatam ho gayi hai, isliye ${amount} ka payment nahi hua.`,
          `Naya card yahan add kar sakte hain: ${link}`,
          optOut,
        ];
      case "BANK_GATEWAY_DEGRADED":
        return [
          `Namaste ${who}, ${MERCHANT} se Boa.`,
          `Aapke ${amount} ke payment mein bank ki taraf se dikkat thi — galti aapki nahi thi.`,
          `Ab sab theek hai, ek click mein ho jayega: ${link}`,
          optOut,
        ];
      default:
        return [
          `Namaste ${who}, ${MERCHANT} se Boa.`,
          attempt > 1
            ? `Bas ek aakhri reminder — ${amount} ka payment abhi bhi pending hai.`
            : `Aapka ${amount} ka payment adhoora reh gaya tha.`,
          `Yahan se pura kar sakte hain: ${link}`,
          optOut,
        ];
    }
  }

  switch (record.rootCause) {
    case "INSUFFICIENT_FUNDS":
      return [
        `Hi ${who}, Boa here on behalf of ${MERCHANT}.`,
        `Your ${amount} payment didn't go through — the bank returned insufficient balance.`,
        `Finish it whenever suits you: ${link}`,
        optOut,
      ];
    case "CARD_EXPIRED":
      return [
        `Hi ${who}, Boa here on behalf of ${MERCHANT}.`,
        `The card on file has expired, so the ${amount} debit couldn't be taken.`,
        `Add a current card here: ${link}`,
        optOut,
      ];
    case "BANK_GATEWAY_DEGRADED":
      return [
        `Hi ${who}, Boa here on behalf of ${MERCHANT}.`,
        `Your ${amount} payment failed at the bank, not at your end.`,
        `It's clear now and takes one tap: ${link}`,
        optOut,
      ];
    default:
      return [
        `Hi ${who}, Boa here on behalf of ${MERCHANT}.`,
        attempt > 1
          ? `Last note from us — ${amount} is still outstanding.`
          : `You left a ${amount} payment unfinished.`,
        `Pick it up here: ${link}`,
        optOut,
      ];
  }
}

function emailCopy(
  record: PipelineCase,
  customer: CustomerProfile,
  attempt: number,
): { subject: string; lines: string[] } {
  const amount = `₹${inr(record.amountPaise)}`;
  const who = firstName(customer.name);
  const sign = `— Boa, on behalf of ${MERCHANT}`;

  if (record.type === "INVOICE_OVERDUE") {
    const firm = attempt > 1;
    return {
      subject: firm
        ? `Second reminder — ${amount} outstanding`
        : `${amount} invoice is past its due date`,
      lines: [
        `Hello ${who},`,
        firm
          ? `Our ${amount} invoice is still open and now past the agreed terms. We would like to close it this week.`
          : `A gentle note that ${amount} is now past its due date. If it has already been paid, please ignore this.`,
        `Pay in one click below, or reply to this email and a person will pick it up.`,
        sign,
      ],
    };
  }

  if (record.rootCause === "CARD_EXPIRED") {
    return {
      subject: `Your card expired — ${amount} is waiting`,
      lines: [
        `Hello ${who},`,
        `The card saved against this ${
          record.type === "MANDATE_FAILED" ? "subscription" : "order"
        } has expired, so the ${amount} payment could not be taken.`,
        `Adding a current card takes under a minute and nothing else changes.`,
        sign,
      ],
    };
  }

  if (record.rootCause === "MANDATE_REVOKED") {
    return {
      subject: "Your auto-pay was cancelled at the bank",
      lines: [
        `Hello ${who},`,
        `Your bank tells us the auto-debit mandate for this subscription was withdrawn, so the ${amount} charge could not run.`,
        `If that was deliberate, no action is needed. If not, you can re-authorise in one step.`,
        sign,
      ],
    };
  }

  return {
    subject: attempt > 1 ? `Still holding your ${amount}` : `Your ${amount} payment didn't complete`,
    lines: [
      `Hello ${who},`,
      `The ${amount} payment on this order did not complete. Nothing has been charged.`,
      `The link below picks up exactly where you left off.`,
      sign,
    ],
  };
}

/**
 * The Hinglish voice call (PRD 7.8).
 *
 * Simulated telephony, and labelled as such everywhere it appears. The script
 * obeys the rules the dialogue engine is given: introduce itself by name on
 * the merchant's behalf, state the amount, offer the link, seek a promise,
 * never threaten.
 */
function voiceScript(
  record: PipelineCase,
  customer: CustomerProfile,
  outcome: "promise" | "decline" | "no-answer",
  promiseDay: string,
): { transcript: Turn[]; summary: string; intent: string; seconds: number } {
  const who = firstName(customer.name);
  const amount = `₹${inr(record.amountPaise)}`;
  const hinglish = isHinglish(customer);

  const opener = hinglish
    ? `Namaste, main Boa bol rahi hoon, ${MERCHANT} ki taraf se. Kya main ${who} se baat kar rahi hoon?`
    : `Hello, this is Boa calling on behalf of ${MERCHANT}. Am I speaking with ${who}?`;

  if (outcome === "no-answer") {
    return {
      transcript: [
        { speaker: "BOA", text: opener },
        { speaker: "CUSTOMER", text: "[no answer · call ended after 22 seconds]" },
      ],
      summary:
        "Nobody picked up. No voicemail was left, and the per-channel cap of one voice call means there will not be another.",
      intent: "NO_ANSWER",
      seconds: 22,
    };
  }

  if (outcome === "decline") {
    return {
      transcript: hinglish
        ? [
            { speaker: "BOA", text: opener },
            { speaker: "CUSTOMER", text: "Haan, boliye." },
            { speaker: "BOA", text: `Aapka ${amount} ka payment pending hai. Koi dikkat aa rahi hai kya?` },
            {
              speaker: "CUSTOMER",
              text: "Dekhiye, abhi thoda tight chal raha hai. Main abhi commit nahi kar sakta.",
            },
            {
              speaker: "BOA",
              text: "Bilkul samajh sakti hoon, main koi pressure nahi daalungi. Jab aap ready ho, link aapke WhatsApp par hai. Dhanyavaad.",
            },
          ]
        : [
            { speaker: "BOA", text: opener },
            { speaker: "CUSTOMER", text: "Yes, go ahead." },
            { speaker: "BOA", text: `There's ${amount} outstanding. Is something in the way?` },
            {
              speaker: "CUSTOMER",
              text: "Money is tight this month, honestly. I can't commit to a date right now.",
            },
            {
              speaker: "BOA",
              text: "That's completely fine — I won't push. The link stays live on your WhatsApp for whenever it suits. Thank you for your time.",
            },
          ],
      summary:
        "Customer described a cash-flow constraint and declined to commit to a date. Hardship language detected, so the case went to a human and the agent stood down.",
      intent: "HARDSHIP_DECLARED",
      seconds: 48,
    };
  }

  return {
    transcript: hinglish
      ? [
          { speaker: "BOA", text: opener },
          { speaker: "CUSTOMER", text: "Haan ji, boliye." },
          { speaker: "BOA", text: `Aapka ${amount} ka payment abhi tak pending hai. Koi issue tha kya?` },
          { speaker: "CUSTOMER", text: "Nahi nahi, bas month end tha. Main kar dunga." },
          {
            speaker: "BOA",
            text: `Bilkul. Kya main ${promiseDay} tak expect kar sakti hoon? Payment link main WhatsApp par bhej deti hoon.`,
          },
          { speaker: "CUSTOMER", text: `Haan, ${promiseDay} tak ho jayega.` },
          {
            speaker: "BOA",
            text: `Theek hai, maine ${promiseDay}, ${amount} note kar liya hai. Link bhej rahi hoon. Dhanyavaad.`,
          },
        ]
      : [
          { speaker: "BOA", text: opener },
          { speaker: "CUSTOMER", text: "Speaking." },
          { speaker: "BOA", text: `There's ${amount} still outstanding. Was there a problem with it?` },
          { speaker: "CUSTOMER", text: "No, it just slipped past month end. I'll get it done." },
          {
            speaker: "BOA",
            text: `Understood. May I note it for ${promiseDay}? I'll send the payment link on WhatsApp.`,
          },
          { speaker: "CUSTOMER", text: `Yes, ${promiseDay} works.` },
          { speaker: "BOA", text: `Noted — ${promiseDay}, ${amount}. Link on its way. Thank you.` },
        ],
    summary: `Customer confirmed intent to pay and agreed a date. Promise recorded for ${promiseDay} at the full ${amount}; a follow-up is scheduled for that morning.`,
    intent: "PROMISED_TO_PAY",
    seconds: 71,
  };
}

const REPLY_COPY: Record<Sentiment, readonly string[]> = {
  positive: [
    "Sorry, ye reh gaya tha. Aaj sham tak kar deta hoon.",
    "Thanks for the reminder — paying now.",
    "Haan bhej diya, check kar lijiye.",
  ],
  neutral: ["Ok", "Noted.", "Dekh leta hoon."],
  negative: [
    "Stop messaging me about this, I already told your team.",
    "Bahut messages aa rahe hain. Band kijiye.",
  ],
  "opt-out": ["STOP"],
};

/* ------------------------------------------------------------------ */
/* Timeline drafts                                                     */
/* ------------------------------------------------------------------ */

type Draft = {
  kind: EventKind;
  /** Minutes after detection. */
  at: number;
  title: string;
  summary: string;
  badge?: { label: string; tone: Tone };
  body?: EventBody;
};

type BuildContext = {
  record: PipelineCase;
  customer: CustomerProfile;
  origin: OriginObject;
  rand: () => number;
  channels: Channel[];
  /** Which attempt (1-based) had its policy check blocked, if any. */
  blockedAttempt: number | null;
  haltReason: "opt-out" | "sentiment" | "attempts" | null;
  promiseDay: string;
  promiseMinutesAgo: number;
};

function detectedDraft(ctx: BuildContext): Draft {
  const { record, origin, rand } = ctx;
  const error = GATEWAY_ERROR[record.rootCause];
  const instrument = pick(INSTRUMENTS[record.type], rand);
  const bank = pick(BANKS, rand);

  const rows: FactRow[] = [
    { label: "Signal", value: signalLabel(record) },
    { label: origin.kind, value: origin.id, mono: true },
    { label: "Amount", value: `₹${inr(record.amountPaise)}`, mono: true },
    { label: "Instrument", value: `${instrument} · ${bank}` },
  ];

  if (error.code !== "—") {
    rows.push(
      { label: "Error code", value: error.code, mono: true },
      { label: "Reason", value: error.reason, mono: true },
      { label: "Reported by", value: error.source },
    );
  }

  if (record.rootCause === "BANK_GATEWAY_DEGRADED") {
    rows.push({
      label: "Detector",
      value: `${bank} success rate 61.4% over 15 min · z −3.4 vs baseline`,
      mono: true,
    });
  }

  if (record.type === "CHECKOUT_ABANDONED") {
    rows.push({ label: "Left at", value: "Payment step · cart idle 41 min" });
  }

  if (record.type === "INVOICE_OVERDUE") {
    rows.push({ label: "Reference", value: origin.reference, mono: true });
  }

  return {
    kind: "DETECTED",
    at: 0,
    title: signalLabel(record),
    summary:
      error.code === "—"
        ? record.type === "INVOICE_OVERDUE"
          ? `${origin.reference} passed its due date · no gateway error to read`
          : "Cart abandoned at the payment step · no gateway error to read"
        : `${error.code} · ${error.reason}`,
    body: { type: "facts", rows },
  };
}

function rulesSecondLine(cause: RootCause, rand: () => number): string {
  switch (cause) {
    case "BANK_GATEWAY_DEGRADED":
      return `${pick(
        BANKS,
        rand,
      )} UPI success rate fell to 61.4% over fifteen minutes, twenty-four points under its median for this hour — the failure is the bank's, not the customer's.`;
    case "INSUFFICIENT_FUNDS":
      return "The issuer declined on balance, not on validity: the instrument is live and the mandate intact, so this is a timing problem rather than a capability one.";
    case "CARD_EXPIRED":
      return "Expiry on the saved token is behind the debit date, so every future attempt against it fails identically until the card is replaced.";
    case "MANDATE_REVOKED":
      return "The customer withdrew the e-mandate at their bank, which no re-presentation can undo — only a fresh authorisation will.";
    default:
      return "The signal matched a single rule cleanly, with no competing candidate above the margin.";
  }
}

function diagnosedDraft(ctx: BuildContext, at: number): Draft {
  const { record, rand } = ctx;
  const cause = ROOT_CAUSE_META[record.rootCause];
  const confidence = record.confidence ?? 0;
  const viaRules = record.method === "RULES";
  const error = GATEWAY_ERROR[record.rootCause];
  const below = confidence < 0.6;

  const reasoning = viaRules
    ? [
        `Error reason ${error.reason} maps to ${record.rootCause} in the rules table — one lookup, no model call.`,
        rulesSecondLine(record.rootCause, rand),
      ]
    : [
        "No rule matched: the error code was generic and the checkout signals disagreed with it, so the case went to the model.",
        below
          ? `The model returned ${cause.label.toLowerCase()} at ${confidence.toFixed(
              2,
            )} — under the 0.60 floor, so Boa escalated instead of guessing.`
          : `The model returned ${cause.label.toLowerCase()} at ${confidence.toFixed(
              2,
            )} — over the 0.60 floor, so Boa proceeded without a human.`,
      ];

  const rows: FactRow[] = [
    { label: "Root cause", value: record.rootCause, mono: true },
    {
      label: "Confidence",
      value: confidence.toFixed(2),
      mono: true,
      tone: below ? "halted" : undefined,
    },
    { label: "Threshold", value: "0.60 · escalate below", mono: true },
    {
      label: "Method",
      value: viaRules ? `rules-table · R-${String(between(11, 48, rand))}` : "LLM · Gemini Flash",
      mono: true,
    },
  ];

  if (viaRules) {
    rows.push(
      { label: "Tokens", value: "0 · no model call", mono: true },
      { label: "Latency", value: `${between(2, 9, rand)} ms`, mono: true },
    );
  } else {
    rows.push(
      {
        label: "Tokens",
        value: `${between(680, 1240, rand)} in · ${between(90, 220, rand)} out`,
        mono: true,
      },
      { label: "Latency", value: `${between(420, 1600, rand)} ms`, mono: true },
      { label: "Prompt", value: "Masked identifiers only — PII rule (PRD 9.9)" },
    );
  }

  return {
    kind: "DIAGNOSED",
    at,
    title: `Diagnosed — ${cause.label.toLowerCase()}`,
    summary: `confidence ${confidence.toFixed(2)} · ${viaRules ? "rules table" : "LLM"}`,
    badge: {
      label: viaRules ? "method: rules-table" : "method: LLM",
      tone: viaRules ? "neutral" : "diagnosis",
    },
    body: { type: "diagnosis", reasoning, rows },
  };
}

function plannedDraft(ctx: BuildContext, at: number, attempt: number, channel: Channel): Draft {
  const { record } = ctx;
  const amount = `₹${inr(record.amountPaise)}`;

  const PLANS: Record<
    Channel,
    { chosen: string; because: string; rejected: { option: string; reason: string }[] }
  > = {
    RETRY: {
      chosen:
        record.type === "MANDATE_FAILED"
          ? `Re-present the mandate, attempt ${attempt} of ${record.attemptCap}`
          : "Silent retry once the gateway monitor clears",
      because:
        record.rootCause === "BANK_GATEWAY_DEGRADED"
          ? "The failure was the bank's. Messaging a customer about our own outage costs goodwill and recovers nothing, so the cheapest win is tried first."
          : "The instrument is valid and the mandate is live, so the debit itself is worth another run before anyone is contacted.",
      rejected: [
        {
          option: "WhatsApp nudge now",
          reason: "The customer did nothing wrong — a nudge here reads as blame",
        },
        {
          option: "Payment link by email",
          reason: "Same ask, one day slower, and it spends a contact from the cap",
        },
      ],
    },
    WHATSAPP: {
      chosen: `WhatsApp nudge with a fresh payment link, attempt ${attempt} of ${record.attemptCap}`,
      because:
        record.rootCause === "CARD_EXPIRED"
          ? "Nothing recovers this until the customer replaces the card, and WhatsApp is where an update link actually gets tapped."
          : "The customer has to act, and WhatsApp is the channel this customer has opened before. One message, one link, no chase.",
      rejected: [
        {
          option: "Voice call",
          reason: `Reserved for attempt 3 and above — disproportionate to ${amount} today`,
        },
        {
          option: "Discount offer",
          reason: "Needs human approval, and no price-sensitivity signal exists yet",
        },
      ],
    },
    EMAIL: {
      chosen: `Email with the payment link, attempt ${attempt} of ${record.attemptCap}`,
      because:
        record.type === "INVOICE_OVERDUE"
          ? "Receivables are settled in writing. An email is the record an accounts inbox expects and can forward internally."
          : "The last contact was on WhatsApp and that channel's cool-down is still running, so email is the next allowed window.",
      rejected: [
        {
          option: "Second WhatsApp",
          reason: "Inside the 20h channel cool-down — the gate would block it",
        },
        {
          option: "Voice call",
          reason: "One written reminder has not been answered yet; calling now is premature",
        },
      ],
    },
    VOICE: {
      chosen: "Hinglish voice call, seeking a promise to pay",
      because:
        "Two written nudges went unanswered and the amount justifies a call. A conversation can surface a date, which no message can.",
      rejected: [
        {
          option: "Third written nudge",
          reason: "Two were ignored; a third is noise and burns the last attempt",
        },
        {
          option: "Escalate to a human now",
          reason: "No dispute or hardship signal — the agent is still inside its bounds",
        },
      ],
    },
  };

  const plan = PLANS[channel];

  return {
    kind: "PLANNED",
    at,
    title: `Planned — ${CHANNEL_META[channel].label.toLowerCase()}`,
    summary: plan.chosen,
    badge: { label: `attempt ${attempt}/${record.attemptCap}`, tone: "neutral" },
    body: { type: "plan", ...plan },
  };
}

function policyDraft(
  ctx: BuildContext,
  at: number,
  attempt: number,
  channel: Channel,
  blocked: "quiet" | "optout" | "approval" | null,
  hoursSinceLast: number | null,
): Draft {
  const { record, rand } = ctx;
  const sendTime =
    blocked === "quiet"
      ? "22:10"
      : `${String(between(9, 20, rand)).padStart(2, "0")}:${String(between(0, 59, rand)).padStart(
          2,
          "0",
        )}`;
  const silent = channel === "RETRY";

  const checks: PolicyCheck[] = [
    {
      name: "Quiet hours",
      verdict: silent ? "skip" : blocked === "quiet" ? "block" : "pass",
      note: silent
        ? "Exempt — a silent retry contacts nobody"
        : blocked === "quiet"
          ? `Send fell at ${sendTime} IST, inside 21:00–09:00 · rescheduled to 09:00`
          : `${sendTime} IST is inside the 09:00–21:00 window`,
    },
    { name: "Attempt cap", verdict: "pass", note: `${attempt} of ${record.attemptCap} used` },
    {
      name: "Cool-down",
      verdict: "pass",
      note:
        hoursSinceLast === null
          ? "First contact on this case"
          : `${hoursSinceLast}h since the last contact · minimum 20h`,
    },
    {
      name: "Opt-out",
      verdict: blocked === "optout" ? "block" : "pass",
      note:
        blocked === "optout"
          ? "STOP received — all channels closed for this customer, permanently"
          : "No opt-out on record for this customer",
    },
    {
      name: "Sentiment halt",
      verdict: "pass",
      note: attempt > 1 ? "Last reply classified neutral" : "No reply to classify yet",
    },
    {
      name: "Escalation gate",
      verdict: blocked === "approval" ? "block" : "pass",
      note:
        blocked === "approval"
          ? "Discount requested — every discount needs a human"
          : `₹${inr(
              record.amountPaise,
            )} is under the ₹25,000 approval threshold · no discount requested`,
    },
  ];

  if (record.type === "MANDATE_FAILED") {
    checks.push({
      name: "Re-presentation spacing",
      verdict: "pass",
      note: `${attempt} of 3 this cycle · 3 clear days since the last presentation (RBI e-mandate discipline)`,
    });
  }

  const passed = checks.filter((c) => c.verdict === "pass").length;
  const total = checks.filter((c) => c.verdict !== "skip").length;
  const isBlocked = blocked !== null;

  return {
    kind: "POLICY_CHECK",
    at,
    title: isBlocked ? "Policy check — blocked" : `Policy check — ${passed}/${total} passed`,
    summary: isBlocked
      ? blocked === "quiet"
        ? "Quiet hours · rescheduled to 09:00 IST"
        : blocked === "optout"
          ? "Opt-out on record · contact refused on every channel"
          : "Escalation gate · sent to the approvals queue"
      : `PolicyGate v4 cleared ${CHANNEL_META[channel].label.toLowerCase()} for ${sendTime} IST`,
    // A badge only where it adds something. The title already carries "5/5
    // passed", so a passing check gets no second copy of its own score; the
    // blocked one keeps its mark because that is the node a reader is
    // scanning for. Green is not spent here either - it means recovered money
    // and nothing else (PRD 6.4).
    badge: isBlocked ? { label: "BLOCKED", tone: "halted" } : undefined,
    body: {
      type: "policy",
      checks,
      rows: [
        { label: "Policy version", value: "v4", mono: true },
        { label: "Decision", value: isBlocked ? "BLOCKED" : "ALLOW", mono: true },
        { label: "Evaluated in", value: `${between(1, 6, rand)} ms`, mono: true },
      ],
    },
  };
}

function actionDraft(
  ctx: BuildContext,
  at: number,
  attempt: number,
  channel: Channel,
  voiceOutcome: "promise" | "decline" | "no-answer",
): Draft {
  const { record, customer, origin, rand } = ctx;

  if (channel === "RETRY") {
    const captured = record.stage === "recovered" && attempt === ctx.channels.length;
    const paymentId = razorpayId("pay", `${record.id}/retry/${attempt}`);
    return {
      kind: "RETRY_EXECUTED",
      at,
      title:
        record.type === "MANDATE_FAILED"
          ? `Mandate re-presented — ${attempt} of 3 this cycle`
          : "Silent retry executed",
      summary: captured
        ? `Captured ₹${inr(record.amountPaise)} · ${paymentId}`
        : `Declined again · ${GATEWAY_ERROR[record.rootCause].reason}`,
      badge: { label: captured ? "captured" : "failed", tone: captured ? "recovered" : "halted" },
      body: {
        type: "facts",
        rows: [
          { label: "Payment", value: paymentId, mono: true },
          { label: "Against", value: origin.id, mono: true },
          {
            label: "Result",
            value: captured ? "captured" : "failed",
            mono: true,
            tone: captured ? "recovered" : "halted",
          },
          { label: "Gateway latency", value: `${between(310, 2400, rand)} ms`, mono: true },
          { label: "Customer contacted", value: "No — silent retry" },
          { label: "Mode", value: CHANNEL_META.RETRY.mode },
        ],
      },
    };
  }

  if (channel === "WHATSAPP") {
    const lines = whatsappCopy(record, customer, attempt);
    return {
      kind: "WHATSAPP_SENT",
      at,
      // The message itself is quoted directly under this node, so the summary
      // line carries what the quote cannot: who it went to and where in the
      // ladder it sits.
      title: "WhatsApp nudge sent",
      summary: `Attempt ${attempt} of ${record.attemptCap} · to ${customer.phone}`,
      badge: { label: "delivered", tone: "neutral" },
      body: {
        type: "message",
        channel: "WHATSAPP",
        lines,
        link: payLink(record),
        rows: [
          { label: "To", value: customer.phone, mono: true },
          { label: "Template", value: `tug_recovery_${record.rootCause.toLowerCase()}`, mono: true },
          { label: "Provider", value: CHANNEL_META.WHATSAPP.mode },
          { label: "Message id", value: `SM${hex(`${record.id}/wa/${attempt}`, 12)}`, mono: true },
          { label: "Status", value: "delivered · read", mono: true },
          { label: "Drafted by", value: `LLM · ${between(180, 420, rand)} tokens`, mono: true },
        ],
      },
    };
  }

  if (channel === "EMAIL") {
    const mail = emailCopy(record, customer, attempt);
    return {
      kind: "EMAIL_SENT",
      at,
      title: "Email sent",
      summary: `Attempt ${attempt} of ${record.attemptCap} · to ${customer.email}`,
      badge: { label: "delivered", tone: "neutral" },
      body: {
        type: "message",
        channel: "EMAIL",
        subject: mail.subject,
        lines: mail.lines,
        link: payLink(record),
        rows: [
          { label: "To", value: customer.email, mono: true },
          { label: "Provider", value: CHANNEL_META.EMAIL.mode },
          { label: "Message id", value: `re_${hex(`${record.id}/em/${attempt}`, 14)}`, mono: true },
          { label: "Status", value: rand() < 0.62 ? "delivered · opened" : "delivered", mono: true },
          { label: "Drafted by", value: `LLM · ${between(240, 520, rand)} tokens`, mono: true },
        ],
      },
    };
  }

  const call = voiceScript(record, customer, voiceOutcome, ctx.promiseDay);
  return {
    kind: "VOICE_CALL",
    at,
    title: "Voice call placed",
    summary: `${isHinglish(customer) ? "Hinglish" : "English"} · ${call.seconds}s · intent ${
      call.intent
    }`,
    badge: { label: "simulated telephony", tone: "waiting" },
    body: {
      type: "voice",
      seconds: call.seconds,
      transcript: call.transcript,
      summary: call.summary,
      intent: call.intent,
      rows: [
        { label: "To", value: customer.phone, mono: true },
        { label: "Language", value: customer.language, mono: true },
        { label: "Voice", value: "Sarvam Bulbul · hi-IN", mono: true },
        { label: "Dialogue", value: "Gemini Flash · turn-by-turn", mono: true },
        {
          label: "Telephony",
          value: "Simulated — the production path is Twilio/Exotel media streams",
        },
        { label: "Detected intent", value: call.intent, mono: true },
      ],
    },
  };
}

function replyDraft(ctx: BuildContext, at: number, channel: Channel, sentiment: Sentiment): Draft {
  const { rand, customer } = ctx;
  const text = pick(REPLY_COPY[sentiment], rand);
  const score = {
    positive: "+0.71",
    neutral: "+0.08",
    negative: "−0.82",
    "opt-out": "n/a · keyword match",
  }[sentiment];

  return {
    kind: "CUSTOMER_REPLY",
    at,
    title: `${customer.name} replied`,
    summary: `Inbound on ${CHANNEL_META[channel].label} · ${
      sentiment === "opt-out" ? "opt-out keyword matched" : `classified ${sentiment}`
    }`,
    badge: {
      label: sentiment === "opt-out" ? "opt-out keyword" : sentiment,
      tone:
        sentiment === "positive"
          ? "recovered"
          : sentiment === "negative" || sentiment === "opt-out"
            ? "halted"
            : "neutral",
    },
    body: {
      type: "reply",
      channel,
      text,
      sentiment,
      rows: [
        { label: "Channel", value: CHANNEL_META[channel].label },
        { label: "Sentiment", value: `${sentiment} · ${score}`, mono: true },
        { label: "Classified by", value: "Groq · Llama-class · 140 tokens", mono: true },
        {
          label: "Consequence",
          value:
            sentiment === "opt-out"
              ? "Immediate halt on every channel — the one rule that cannot be switched off"
              : sentiment === "negative"
                ? "Contact halted and the case handed to a human"
                : "Case continues inside its bounds",
        },
      ],
    },
  };
}

/**
 * Why this case is a human's, in the queue's own words.
 *
 * The gate comes from `approvals-data` rather than being decided again here:
 * the Approvals Queue prints the same phrase against the same case, and two
 * implementations of "why is this escalated" is two answers a panelist can
 * catch you between.
 */
function escalationReason(record: PipelineCase): string {
  const amount = `₹${inr(record.amountPaise)}`;

  switch (approvalGateOf(record)) {
    case "confidence_below_threshold":
      return `Diagnosis confidence ${(record.confidence ?? 0).toFixed(2)} is under the 0.60 floor`;
    case "hardship_language":
      return "Reply contained hardship language — the agent stands down";
    case "b2b_high_value":
      return `B2B receivable of ${amount} is over the ₹25,000 approval gate`;
    default:
      return `Discount of 12% (₹${inr(
        Math.round(record.amountPaise * 0.12),
      )}) requested to close ${amount}`;
  }
}

/**
 * The pair of nodes a case gains when a gate stopped it mid-story.
 *
 * A decision on the Approvals Queue is not an event that happened somewhere
 * else: it happened to this case, so it is on this case's timeline and in this
 * case's hash chain, with the human named as the actor. The queue's History
 * tab and these two nodes are the same rows read from two directions - which
 * is the only arrangement in which neither can lie about the other.
 */
function approvalRequestDraft(ctx: BuildContext, at: number, decided: DecidedApproval): Draft {
  const { record } = ctx;

  return {
    kind: "ESCALATED",
    at,
    title: "Escalated to a human",
    summary: decided.headline,
    badge: { label: "sent to approvals", tone: "waiting" },
    body: {
      type: "facts",
      rows: [
        { label: "Gate", value: decided.gate, mono: true },
        { label: "Rule", value: GATE_META[decided.gate].rule },
        { label: "Requested", value: decided.headline },
        { label: "Agent state", value: "Paused on this case until a human decides" },
        { label: "Queued to", value: `Approvals queue · ${decided.id}`, mono: true },
        {
          label: "Attempts at the time",
          value: `${decided.afterAttempt} of ${record.attemptCap}`,
          mono: true,
        },
      ],
    },
  };
}

function approvalDecisionDraft(ctx: BuildContext, at: number, decided: DecidedApproval): Draft {
  const { record } = ctx;
  const approved = decided.decision === "approved";
  const latency = formatLatency(decided.latencySeconds);

  return {
    kind: "APPROVAL_DECIDED",
    at,
    title: approved ? `Approved by ${decided.decidedBy}` : `Rejected by ${decided.decidedBy}`,
    summary: approved
      ? `Released after ${latency} — the case resumed inside its existing bounds`
      : `${decided.reason} — Boa carried on without the concession`,
    // Green is recovered money and nothing else (PRD 6.4), so a yes reads as
    // the plainest chalk on the rail rather than borrowing that colour.
    badge: { label: approved ? "approved" : "rejected", tone: approved ? "neutral" : "halted" },
    body: {
      type: "facts",
      rows: [
        { label: "Decision", value: approved ? "APPROVED" : "REJECTED", mono: true },
        { label: "Decided by", value: decided.decidedBy },
        { label: "Response time", value: latency, mono: true },
        ...(decided.reason ? [{ label: "Reason given", value: decided.reason }] : []),
        {
          label: "Effect",
          value: approved
            ? `The gate re-ran against the approved action and the case continued at attempt ${
                decided.afterAttempt + 1
              } of ${record.attemptCap}`
            : `No concession was made · the case continued on the standard playbook and closed at its cap`,
        },
        { label: "Request", value: decided.id, mono: true },
        { label: "Audited as", value: "HUMAN · APPROVAL_DECIDED", mono: true },
      ],
    },
  };
}

function terminalDrafts(ctx: BuildContext, t: number, lastChannel: Channel): Draft[] {
  const { record, rand } = ctx;
  const amount = `₹${inr(record.amountPaise)}`;
  const at = t + between(6, 90, rand);

  switch (record.stage) {
    case "recovered": {
      const method =
        lastChannel === "RETRY"
          ? "silent retry"
          : `payment link from the ${CHANNEL_META[lastChannel].label.toLowerCase()}`;
      return [
        {
          kind: "RECOVERED",
          at,
          title: `Recovered ${amount}`,
          summary: `Paid via ${method} · ${record.attempts} attempt${
            record.attempts === 1 ? "" : "s"
          } of ${record.attemptCap}`,
          badge: { label: "recovered", tone: "recovered" },
          body: {
            type: "facts",
            rows: [
              { label: "Amount", value: amount, mono: true, tone: "recovered" },
              { label: "Method", value: method },
              { label: "Payment", value: razorpayId("pay", `${record.id}/win`), mono: true },
              {
                label: "Attempts used",
                value: `${record.attempts} of ${record.attemptCap}`,
                mono: true,
              },
              { label: "Time to recovery", value: formatSpan(at), mono: true },
              {
                label: "Contacts sent",
                value: String(ctx.channels.filter((c) => c !== "RETRY").length),
                mono: true,
              },
            ],
          },
        },
      ];
    }

    case "promised":
      return [
        {
          kind: "PROMISE_RECORDED",
          at,
          title: `Promise recorded — ${amount}`,
          summary: `Customer committed to ${ctx.promiseDay} · follow-up scheduled that morning`,
          badge: { label: "promised", tone: "waiting" },
          body: {
            type: "promise",
            amountPaise: record.amountPaise,
            dateLabel: ctx.promiseDay,
            daysAway: Math.max(1, Math.round(Math.abs(ctx.promiseMinutesAgo) / 1440)),
            rows: [
              { label: "Promised amount", value: amount, mono: true },
              { label: "Promised date", value: ctx.promiseDay, mono: true },
              { label: "Source", value: "Voice call · intent PROMISED_TO_PAY", mono: true },
              { label: "Follow-up", value: `Scheduled ${ctx.promiseDay} · 09:30 IST`, mono: true },
              { label: "If broken", value: "One reminder, then escalate — never a fourth chase" },
            ],
          },
        },
      ];

    case "escalated": {
      const reason = escalationReason(record);

      return [
        {
          kind: "ESCALATED",
          at,
          title: "Escalated to a human",
          summary: reason,
          badge: { label: "awaiting approval", tone: "waiting" },
          body: {
            type: "facts",
            rows: [
              { label: "Gate", value: approvalGateOf(record), mono: true },
              { label: "Reason", value: reason },
              { label: "Agent state", value: "Paused on this case until a human decides" },
              { label: "Queued to", value: "Approvals queue", mono: true },
              { label: "Contacts sent so far", value: String(record.attempts), mono: true },
            ],
          },
        },
      ];
    }

    case "halted": {
      const optOut = ctx.haltReason === "opt-out";
      return [
        {
          kind: "HALTED",
          at,
          title: optOut ? "Halted — opt-out" : "Halted — negative sentiment",
          summary: optOut
            ? "STOP received · every channel closed for this customer, permanently"
            : "Reply classified strongly negative · contact stopped and a human notified",
          badge: { label: "halted", tone: "halted" },
          body: {
            type: "facts",
            rows: [
              {
                label: "Stopping rule",
                value: optOut ? "Opt-out keyword halt (non-negotiable)" : "Negative-sentiment halt",
                mono: true,
              },
              { label: "Scope", value: optOut ? "All channels, all future cases" : "This case" },
              { label: "Left on the table", value: amount, mono: true, tone: "halted" },
              {
                label: "Attempts used",
                value: `${record.attempts} of ${record.attemptCap}`,
                mono: true,
              },
              {
                label: "Why it is right",
                value: optOut
                  ? "The rule cannot be disabled in the Policies UI — that is the point of it"
                  : "A customer who is angry is not a customer another nudge recovers",
              },
            ],
          },
        },
      ];
    }

    case "exhausted":
      return [
        {
          kind: "HALTED",
          at,
          title: "Exhausted — attempt cap reached",
          summary: `${record.attemptCap} of ${record.attemptCap} attempts used · the case closes without the money`,
          badge: { label: "exhausted", tone: "neutral" },
          body: {
            type: "facts",
            rows: [
              { label: "Stopping rule", value: "Attempt cap", mono: true },
              {
                label: "Attempts used",
                value: `${record.attemptCap} of ${record.attemptCap}`,
                mono: true,
              },
              { label: "Left on the table", value: amount, mono: true },
              { label: "Further contact", value: "Blocked at the gate — no fifth attempt exists" },
              {
                label: "Why it is right",
                value:
                  "A bounded agent that stops is the product; one that keeps going is a spam cannon",
              },
            ],
          },
        },
      ];

    default:
      return [];
  }
}

function buildDrafts(ctx: BuildContext): Draft[] {
  const { record, rand, channels } = ctx;
  const drafts: Draft[] = [detectedDraft(ctx)];

  // A decision this merchant has already taken on this case, if there was one.
  const decided = decidedApprovalFor(record.id);

  let t = 0;

  if (record.stage !== "detected") {
    t += between(1, 5, rand);
    drafts.push(diagnosedDraft(ctx, t));
  }

  const firstGap =
    record.type === "CHECKOUT_ABANDONED"
      ? between(30, 60, rand)
      : record.rootCause === "BANK_GATEWAY_DEGRADED"
        ? between(12, 42, rand)
        : between(6, 30, rand);

  let lastContactAt: number | null = null;

  channels.forEach((channel, index) => {
    const attempt = index + 1;
    t += attempt === 1 ? firstGap : between(1_180, 1_520, rand);

    const blocked = ctx.blockedAttempt === attempt ? "quiet" : null;
    const hoursSinceLast = lastContactAt === null ? null : Math.round((t - lastContactAt) / 60);

    drafts.push(plannedDraft(ctx, t, attempt, channel));
    t += 1;
    drafts.push(policyDraft(ctx, t, attempt, channel, blocked, hoursSinceLast));

    // A blocked send is not a lost send: it waits for the window to open.
    t += blocked === "quiet" ? between(300, 640, rand) : between(1, 4, rand);

    const isLast = attempt === channels.length;
    const voiceOutcome: "promise" | "decline" | "no-answer" =
      record.stage === "promised"
        ? "promise"
        : record.stage === "escalated" || record.stage === "halted"
          ? "decline"
          : "no-answer";

    drafts.push(actionDraft(ctx, t, attempt, channel, voiceOutcome));
    if (channel !== "RETRY") lastContactAt = t;

    // Replies are the exception, not the rule — most nudges are simply ignored.
    const wantsHaltReply =
      isLast && (ctx.haltReason === "opt-out" || ctx.haltReason === "sentiment");
    const wantsWinReply = isLast && record.stage === "recovered" && channel !== "RETRY";
    const spontaneous = channel !== "VOICE" && rand() < 0.34;

    if (channel !== "RETRY" && (wantsHaltReply || wantsWinReply || spontaneous)) {
      t += between(14, 260, rand);
      const sentiment: Sentiment = wantsHaltReply
        ? ctx.haltReason === "opt-out"
          ? "opt-out"
          : "negative"
        : wantsWinReply
          ? "positive"
          : rand() < 0.6
            ? "neutral"
            : "positive";
      drafts.push(replyDraft(ctx, t, channel, sentiment));
    }

    // The gate stopped this attempt's successor and a human answered. Both
    // nodes land here, in the middle of the story rather than after it,
    // because that is where the case actually paused.
    if (decided && attempt === decided.afterAttempt) {
      t += between(4, 40, rand);
      drafts.push(approvalRequestDraft(ctx, t, decided));
      // Seconds later, so the two share a minute on the board - which is the
      // point of the latency figure.
      drafts.push(approvalDecisionDraft(ctx, t, decided));
      t += 1;
    }
  });

  drafts.push(...terminalDrafts(ctx, t, channels[channels.length - 1] ?? "RETRY"));
  return drafts;
}

/* ------------------------------------------------------------------ */
/* Pending work                                                        */
/* ------------------------------------------------------------------ */

/**
 * What Boa does next, drawn as timeline nodes that have not happened yet.
 *
 * The Case Detail timeline auto-appends live (PRD 6.3): these are the nodes
 * that arrive. They are the scheduled next steps of the same playbook rather
 * than a canned animation, and every bound on the panel to the left has to
 * permit them first - a case whose cool-down has eighteen hours left does not
 * get a contact eight seconds after the page loads, because that would make
 * the Bounds panel a decoration and this page's whole argument is that it is
 * not one.
 */
function buildPending(
  ctx: BuildContext,
  bounds: Bounds,
  minutesSinceLastContact: number | null,
): CaseEvent[] {
  const { record } = ctx;
  if (STAGE_META[record.stage].group !== "open") return [];
  // Detected has no plan yet; escalated is a human's turn; promised is waiting
  // on a date the customer named, not on anything Boa is about to do.
  if (record.stage === "escalated" || record.stage === "detected") return [];
  if (record.stage === "promised") return [];
  if (record.attempts >= record.attemptCap) return [];
  if (bounds.optedOut) return [];

  const attempt = record.attempts + 1;
  const nextChannel = channelPlan(record, record.attemptCap)[attempt - 1] ?? "WHATSAPP";

  // A cool-down bars contact, not action. A silent retry reaches the gateway
  // and nobody else, so it is exempt here for exactly the reason PRD 9.1
  // exempts it from quiet hours - and it is the only thing that may run.
  if (bounds.coolDownMinutesLeft !== null && nextChannel !== "RETRY") return [];

  const rand = rngFrom(hash32(`${record.id}/pending`));
  const next: BuildContext = { ...ctx, rand };

  const drafts: Draft[] = [
    plannedDraft(next, 0, attempt, nextChannel),
    policyDraft(
      next,
      0,
      attempt,
      nextChannel,
      null,
      // The real gap, not a placeholder: a case whose only prior action was a
      // silent retry has never contacted anyone, and the check has to say so.
      minutesSinceLastContact === null ? null : Math.round(minutesSinceLastContact / 60),
    ),
    actionDraft(next, 0, attempt, nextChannel, "no-answer"),
  ];

  // Stamped one minute apart from the batch clock rather than from the
  // browser's: a timeline whose last three nodes jump three hours ahead of the
  // rest stops being a chronology, and the "just now" badge already carries
  // the fact that these arrived while you watched.
  return drafts.map((draft, i) => ({
    id: `${record.id}-pending-${i}`,
    seq: 1_000 + i,
    kind: draft.kind,
    minutesAgo: -(i + 1),
    title: draft.title,
    summary: draft.summary,
    badge: draft.badge,
    body: draft.body,
  }));
}

/* ------------------------------------------------------------------ */
/* Audit ledger                                                        */
/* ------------------------------------------------------------------ */

const AUDIT_MAP: Record<EventKind, { actor: AuditEntry["actor"]; action: string }> = {
  DETECTED: { actor: "SYSTEM", action: "CASE_OPENED" },
  DIAGNOSED: { actor: "BOA", action: "DIAGNOSIS_WRITTEN" },
  PLANNED: { actor: "BOA", action: "ACTION_PLANNED" },
  POLICY_CHECK: { actor: "POLICY", action: "POLICY_EVALUATED" },
  EMAIL_SENT: { actor: "BOA", action: "ACTION_EXECUTED" },
  WHATSAPP_SENT: { actor: "BOA", action: "ACTION_EXECUTED" },
  VOICE_CALL: { actor: "BOA", action: "ACTION_EXECUTED" },
  RETRY_EXECUTED: { actor: "BOA", action: "ACTION_EXECUTED" },
  CUSTOMER_REPLY: { actor: "SYSTEM", action: "INBOUND_RECORDED" },
  PROMISE_RECORDED: { actor: "BOA", action: "PROMISE_RECORDED" },
  ESCALATED: { actor: "POLICY", action: "ESCALATION_RAISED" },
  APPROVAL_DECIDED: { actor: "HUMAN", action: "APPROVAL_DECIDED" },
  HALTED: { actor: "POLICY", action: "CONTACT_HALTED" },
  RECOVERED: { actor: "SYSTEM", action: "PAYMENT_CAPTURED" },
};

/**
 * The hash chain, computed the way the ledger computes it: each row's digest
 * covers its own payload and the digest before it, so a row cannot be altered
 * or removed without every row after it failing to verify.
 */
function buildAudit(caseId: string, events: CaseEvent[]): AuditEntry[] {
  let prev = "0".repeat(10);
  return events.map((event, i) => {
    const map = AUDIT_MAP[event.kind];
    const digest = hex(`${caseId}|${i}|${event.kind}|${event.title}|${prev}`, 10);
    const entry: AuditEntry = {
      seq: i + 1,
      hash: digest,
      prevHash: prev,
      actor: map.actor,
      action: map.action,
      minutesAgo: event.minutesAgo,
      detail: event.summary,
    };
    prev = digest;
    return entry;
  });
}

/**
 * Continue the chain for work that lands after the page was rendered.
 *
 * Exported rather than duplicated in the view, because a second implementation
 * of the digest is a second thing that can disagree with the ledger - and the
 * whole value of the panel is that it does not.
 */
export function extendAudit(
  caseId: string,
  base: AuditEntry[],
  events: CaseEvent[],
): AuditEntry[] {
  let prev = base.length > 0 ? base[base.length - 1].hash : "0".repeat(10);
  return events.map((event, i) => {
    const map = AUDIT_MAP[event.kind];
    const seq = base.length + i + 1;
    const digest = hex(`${caseId}|${seq - 1}|${event.kind}|${event.title}|${prev}`, 10);
    const entry: AuditEntry = {
      seq,
      hash: digest,
      prevHash: prev,
      actor: map.actor,
      action: map.action,
      minutesAgo: event.minutesAgo,
      detail: event.summary,
    };
    prev = digest;
    return entry;
  });
}

/** A human reached in and changed something. Same chain, different actor. */
export function overrideAuditRow(
  caseId: string,
  base: AuditEntry[],
  override: "paused" | "escalated" | "resolved",
): AuditEntry {
  const prev = base.length > 0 ? base[base.length - 1].hash : "0".repeat(10);
  const seq = base.length + 1;
  const action = {
    paused: "AGENT_PAUSED_BY_HUMAN",
    escalated: "ESCALATED_BY_HUMAN",
    resolved: "RESOLVED_EXTERNALLY",
  }[override];

  return {
    seq,
    hash: hex(`${caseId}|${seq - 1}|${action}|${prev}`, 10),
    prevHash: prev,
    actor: "HUMAN",
    action,
    minutesAgo: 0,
    detail: `Operator override · ${action.toLowerCase().replace(/_/g, " ")}`,
  };
}

/* ------------------------------------------------------------------ */
/* Cost                                                                */
/* ------------------------------------------------------------------ */

/** Production list prices, in paise. Actual spend on the free tiers is zero. */
const PROJECTED = {
  llmPerThousandTokens: 18, // ₹0.18
  email: 10, // ₹0.10
  whatsapp: 35, // ₹0.35
  voice: 420, // ₹4.20
};

function buildOutcome(
  record: PipelineCase,
  events: CaseEvent[],
  channels: Channel[],
  openedMinutesAgo: number,
): Outcome {
  let tokens = 0;
  let llmCalls = 0;

  if (record.method === "LLM") {
    tokens += 1_100;
    llmCalls += 1;
  }
  for (const channel of channels) {
    if (channel === "EMAIL" || channel === "WHATSAPP") {
      tokens += 380;
      llmCalls += 1;
    }
    if (channel === "VOICE") {
      tokens += 2_400;
      llmCalls += 1;
    }
  }
  const replies = events.filter((e) => e.kind === "CUSTOMER_REPLY").length;
  tokens += replies * 140;
  llmCalls += replies;

  const projectedChannelPaise = channels.reduce((sum, channel) => {
    if (channel === "EMAIL") return sum + PROJECTED.email;
    if (channel === "WHATSAPP") return sum + PROJECTED.whatsapp;
    if (channel === "VOICE") return sum + PROJECTED.voice;
    return sum;
  }, 0);

  const stage = record.stage;
  const group = STAGE_META[stage].group;

  const headline =
    stage === "recovered"
      ? `₹${inr(record.recoveredPaise)} recovered`
      : group === "open"
        ? `₹${inr(record.amountPaise)} still in flight`
        : `₹${inr(record.amountPaise)} not recovered`;

  const detail =
    stage === "recovered"
      ? `Full amount · ${record.attempts} attempt${
          record.attempts === 1 ? "" : "s"
        } of ${record.attemptCap} · ${formatSpan(
          openedMinutesAgo - record.updatedMinutesAgo,
        )} from detection`
      : stage === "escalated"
        ? "Waiting on a human decision — the agent has paused itself"
        : stage === "halted"
          ? "Stopped by a rule before the cap was reached"
          : stage === "exhausted"
            ? "Every permitted attempt was used and the case closed honestly"
            : `${record.attempts} of ${record.attemptCap} attempts used · ${record.nextAction}`;

  return {
    stage,
    headline,
    detail,
    atRiskPaise: record.amountPaise,
    recoveredPaise: record.recoveredPaise,
    timeToRecoveryMinutes:
      stage === "recovered" ? openedMinutesAgo - record.updatedMinutesAgo : null,
    contacts: channels.filter((c) => c !== "RETRY").length,
    llmCalls,
    llmTokens: tokens,
    spentPaise: 0,
    projectedLlmPaise: Math.round((tokens / 1_000) * PROJECTED.llmPerThousandTokens),
    projectedChannelPaise,
  };
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

function deadlineNote(record: PipelineCase): string {
  switch (record.type) {
    case "CHECKOUT_ABANDONED":
      return "72h after abandonment, then the case closes";
    case "INVOICE_OVERDUE":
      return "30 days past due, then the case closes — never chase stale debt";
    case "MANDATE_FAILED":
      return "End of the billing cycle, then the case closes";
    default:
      return "7 days after the failure, then the case closes";
  }
}

function buildBounds(
  record: PipelineCase,
  channels: Channel[],
  haltReason: BuildContext["haltReason"],
  minutesSinceLastContact: number | null,
): Bounds {
  const used = (channel: Channel) => channels.filter((c) => c === channel).length;
  const optedOut = haltReason === "opt-out";
  const coolDownLeft =
    minutesSinceLastContact === null || minutesSinceLastContact >= 1_200
      ? null
      : 1_200 - minutesSinceLastContact;

  const closed = STAGE_META[record.stage].group !== "open";
  const closedNote = !closed
    ? null
    : record.stage === "recovered"
      ? "The money came back — the case is closed and nothing further will run."
      : optedOut
        ? "The customer opted out. No contact is possible on any channel, now or later."
        : record.stage === "exhausted"
          ? "Every permitted attempt was used. The case is closed."
          : "A stopping rule ended this case. Nothing further will run.";

  return {
    attemptsUsed: record.attempts,
    attemptCap: record.attemptCap,
    channels: [
      { channel: "WHATSAPP", used: used("WHATSAPP"), cap: 2 },
      { channel: "EMAIL", used: used("EMAIL"), cap: 2 },
      { channel: "VOICE", used: used("VOICE"), cap: 1 },
      { channel: "RETRY", used: used("RETRY"), cap: record.type === "MANDATE_FAILED" ? 3 : 2 },
    ],
    quietHours: "09:00 – 21:00 IST",
    quietNote:
      "Outside this window nothing goes out. Silent retries are exempt — they contact nobody.",
    optedOut,
    optOutNote: optedOut
      ? "STOP received — every channel is closed for this customer"
      : "No opt-out on record",
    coolDownMinutesLeft: closed ? null : coolDownLeft,
    coolDownNote: closed
      ? "Moot — the case has stopped"
      : coolDownLeft === null
        ? "Clear — the 20h minimum gap is satisfied"
        : `${formatSpan(coolDownLeft)} until the next contact is allowed`,
    deadlineNote: deadlineNote(record),
    policyVersion: "v4",
    closed,
    closedNote,
  };
}

/* ------------------------------------------------------------------ */
/* GET /cases/:id                                                      */
/* ------------------------------------------------------------------ */

const cache = new Map<string, CaseDetail>();

export function getCaseDetail(id: string): CaseDetail | null {
  const cached = cache.get(id);
  if (cached) return cached;

  const record = getPipelineCases().find((row) => row.id === id);
  if (!record) return null;

  const built = buildDetail(record);
  cache.set(id, built);
  return built;
}

function buildDetail(record: PipelineCase): CaseDetail {
  const rand = rngFrom(hash32(`tugboat/case/${record.id}`));
  const customer = buildCustomer(record, rand);
  const origin = buildOrigin(record, rand);
  const channels = channelPlan(record, record.attempts);

  const haltReason: BuildContext["haltReason"] =
    record.stage === "halted"
      ? record.nextAction.toLowerCase().includes("opt-out")
        ? "opt-out"
        : "sentiment"
      : record.stage === "exhausted"
        ? "attempts"
        : null;

  // Two cases in five have a send land inside quiet hours, so the red shield is
  // something a panelist can actually find rather than a claim in a caption.
  const blockedAttempt =
    channels.length >= 2 && rand() < 0.42 ? between(2, channels.length, rand) : null;

  // The promised date is ahead of the batch clock, not behind it.
  const promiseMinutesAgo = -between(1_400, 4_300, rand);

  const ctx: BuildContext = {
    record,
    customer,
    origin,
    rand,
    channels,
    blockedAttempt,
    haltReason,
    promiseDay: dayLabel(promiseMinutesAgo),
    promiseMinutesAgo,
  };

  const drafts = buildDrafts(ctx);
  const span = drafts[drafts.length - 1].at;

  // The last event sits exactly on the case's own "last activity", so the
  // timeline and the Pipeline row can never disagree about when this moved.
  const events: CaseEvent[] = drafts.map((draft, i) => ({
    id: `${record.id}-${i}`,
    seq: i + 1,
    kind: draft.kind,
    minutesAgo: record.updatedMinutesAgo + (span - draft.at),
    title: draft.title,
    summary: draft.summary,
    badge: draft.badge,
    body: draft.body,
  }));

  const openedMinutesAgo = events[0].minutesAgo;
  const lastContact = [...events]
    .reverse()
    .find((e) => e.kind === "EMAIL_SENT" || e.kind === "WHATSAPP_SENT" || e.kind === "VOICE_CALL");

  // Bounds first, then the pending work - the limits decide whether there is
  // any, not the other way round.
  const sinceLastContact = lastContact?.minutesAgo ?? null;
  const bounds = buildBounds(record, channels, haltReason, sinceLastContact);

  return {
    record,
    customer,
    origin,
    openedMinutesAgo,
    deadlineLabel: deadlineNote(record),
    bounds,
    events,
    pending: buildPending(ctx, bounds, sinceLastContact),
    outcome: buildOutcome(record, events, channels, openedMinutesAgo),
    audit: buildAudit(record.id, events),
  };
}

/* ------------------------------------------------------------------ */
/* Neighbours                                                          */
/* ------------------------------------------------------------------ */

/** Previous and next case in the batch, so the page is walkable without going back. */
export function getCaseNeighbours(id: string): { prev: string | null; next: string | null } {
  const cases = getPipelineCases();
  const index = cases.findIndex((row) => row.id === id);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: index > 0 ? cases[index - 1].id : null,
    next: index < cases.length - 1 ? cases[index + 1].id : null,
  };
}

export { CASE_TYPE_META, ROOT_CAUSE_META, STAGE_META };
export type { CaseType, PipelineCase, RootCause, Stage };
